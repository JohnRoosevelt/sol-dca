/**
 * TickerHub Durable Object
 *
 * 责任：
 * 1. 持有 1 个 OKX public WS（订阅 SOL-USDT ticker）
 * 2. 持有 N 个 browser WS（Hibernation API 持久化）
 * 3. ticker 推送 → 调 strategy.decide() → OKX private API 下单
 * 4. 写 portfolio + signals + trades:
 *    - DO 内置 sqlite (state.storage.sql) 做热数据, ~ms 写, FIFO 50/30
 *    - D1 做永久归档 (do-worker 跨实例/跨 region 恢复用)
 * 5. 监控：WS 断开 / ticker 30s 静默 / 下单失败 → 飞书 webhook (rate limited)
 * 6. 接收 browser 控制指令（pause / resume / manual / init_dca）
 *
 * 路由（从 Worker fetch 转发）：
 *   GET  /ws              → upgrade WebSocket
 *   GET  /state           → 当前 portfolio + 最近 signals/trades (从 DO storage)
 *   GET  /recent_signals  → 最近 signals 列表 (dev 阶段给 frontend /api/signals)
 *   GET  /recent_trades   → 最近 trades 列表 (dev 阶段给 frontend /api/trades)
 *   POST /control         → { action: 'pause'|'resume'|'init_dca'|'manual_sell', ... }
 */

import { createOkxClient, checkOkxCredentials } from './okx/client.js';
import { subscribeTicker } from './okx/ws-public.js';
import {
	STRATEGY_CONFIG,
	decide,
	applyBuy,
	applySell,
	maybeResetMonth
} from './strategy.js';
import { isSabbath } from './sabbath.js';
import { sendAlert } from './alert.js';

const TICKER_TIMEOUT_MS = 30_000; // ticker 30s 没收到 = 静默
const WS_RECONNECT_MS = 5_000; // OKX WS 断开 5s 后重连
const BALANCE_SYNC_MS = 5 * 60 * 1000; // 5 分钟同步一次 OKX 真实余额
const MONTH_KEY_FMT = (d) => d.toISOString().slice(0, 7); // YYYY-MM

// FIFO 上限: signals 50 条, trades 30 条
const SIGNAL_FIFO_LIMIT = 50;
const TRADE_FIFO_LIMIT = 30;

// DO storage schema (跟 D1 列名一致 snake_case, 数据迁移友好)
const SQL_SCHEMA = `
	CREATE TABLE IF NOT EXISTS portfolio (
		id INTEGER PRIMARY KEY,
		usdt_balance REAL NOT NULL,
		sol_holding REAL NOT NULL,
		last_buy_price REAL,
		total_spent REAL NOT NULL DEFAULT 0,
		total_sold REAL NOT NULL DEFAULT 0,
		current_month_spent REAL NOT NULL DEFAULT 0,
		current_month_reset TEXT,
		consecutive_dca_buys INTEGER NOT NULL DEFAULT 0,
		sell_stairs_triggered TEXT NOT NULL DEFAULT '[]',
		updated_at TEXT NOT NULL
	);
	CREATE TABLE IF NOT EXISTS signals (
		id TEXT PRIMARY KEY,
		price REAL NOT NULL,
		action TEXT NOT NULL,
		reason TEXT NOT NULL,
		drawdown_pct REAL,
		profit_pct REAL,
		usdt_after REAL,
		sol_after REAL,
		mode TEXT NOT NULL,
		created_at TEXT NOT NULL
	);
	CREATE TABLE IF NOT EXISTS trades (
		id TEXT PRIMARY KEY,
		cl_ord_id TEXT NOT NULL UNIQUE,
		side TEXT NOT NULL,
		price REAL NOT NULL,
		amount_usdt REAL NOT NULL,
		amount_sol REAL NOT NULL,
		reason TEXT NOT NULL,
		drawdown_pct REAL,
		multiplier REAL,
		profit_pct REAL,
		mode TEXT NOT NULL,
		okx_order_id TEXT,
		okx_state TEXT,
		created_at TEXT NOT NULL
	);
	CREATE INDEX IF NOT EXISTS idx_signals_created_at ON signals (created_at DESC);
	CREATE INDEX IF NOT EXISTS idx_trades_created_at ON trades (created_at DESC);
`;

export class TickerHub {
	/**
	 * @param {DurableObjectState} state
	 * @param {Env} env
	 */
	constructor(state, env) {
		this.state = state;
		this.env = env;
		this.okx = createOkxClient(env);
		this.missingCredentials = checkOkxCredentials(env);
		this.instId = env.OKX_INST_ID || 'SOL-USDT';
		this.channel = env.OKX_TICKER_CHANNEL || 'tickers';
		this.publicWsUrl = env.OKX_PUBLIC_WS || 'wss://ws.okx.com:8443/ws/v5/public';
		this.alertUrl = env.ALERT_WEBHOOK_URL || '';

		// 内存状态 (不持久化 / 不需要 FIFO 限的)
		/** @type {any} */
		this.portfolio = null;
		this.isPaused = false;
		this.lastTickerAt = 0;
		this.lastTickerPrice = 0;
		this.lastOkxWsState = 'init';
		this.okxWs = null;
		this.reconnectTimer = null;
		this.heartbeatTimer = null;
		this.balanceSyncTimer = null;
		this.recentHoldSignals = []; // 内存 hold 环形缓冲 (前端 fold count 用, 不写 storage)

		// 启动: 建 DO storage 表
		this.state.blockConcurrencyWhile(async () => {
			await this.initStorage();
		});
	}

	/**
	 * 建表 (idempotent, 多次调用 OK)
	 */
	async initStorage() {
		this.state.storage.sql.exec(SQL_SCHEMA);
	}

	/**
	 * 启动：读 portfolio → 启 OKX WS → 启心跳
	 */
	async initialize() {
		await this.loadPortfolio();
		this.startHeartbeat();
		this.connectOkx();
	}

	/**
	 * 读 portfolio (优先 DO storage → D1 恢复 → OKX 真实余额 → 写死 7000)
	 */
	async loadPortfolio() {
		// 1) 优先从 DO storage 读 (热数据, ~ms)
		const rows = this.state.storage.sql.exec('SELECT * FROM portfolio WHERE id = 1').toArray();
		if (rows.length > 0) {
			this.portfolio = this.rowToPortfolio(rows[0]);
			console.log('[TickerHub] loaded portfolio from DO storage:', JSON.stringify(this.portfolio));
			return;
		}

		// 2) DO storage 空 → 从 D1 恢复 (DO 重建后场景, 用 D1 永久归档数据)
		if (this.env.SOL_DCA_DB) {
			try {
				const row = await this.env.SOL_DCA_DB.prepare(
					'SELECT * FROM portfolio_state WHERE id = 1'
				).first();
				if (row) {
					this.portfolio = this.rowToPortfolio(this.d1RowToPortfolioRow(row));
					await this.persistPortfolio();
					console.log('[TickerHub] recovered portfolio from D1 → DO storage');
					return;
				}
			} catch (err) {
				console.error('[TickerHub] D1 recovery failed:', err);
			}
		} else {
			console.warn('[TickerHub] D1 binding missing — skipping D1 recovery');
		}

		// 3) 调 OKX 拿真实 demo 余额
		if (this.missingCredentials.length === 0) {
			try {
				const usdt = await this.okx.getUsdtBalance();
				const sol = await this.okx.getSolBalance();
				this.portfolio = this.defaultPortfolio();
				this.portfolio.usdtBalance = usdt;
				this.portfolio.solHolding = sol;
				await this.persistPortfolio();
				console.log(`[TickerHub] portfolio synced from OKX: ${usdt} USDT + ${sol} SOL`);
				return;
			} catch (err) {
				console.error('[TickerHub] OKX getBalance failed:', err);
			}
		}

		// 4) fallback: 写死 7000
		this.portfolio = this.defaultPortfolio();
		await this.persistPortfolio();
		console.warn('[TickerHub] using hardcoded 7000U default — OKX credentials missing or API failed');
	}

	defaultPortfolio() {
		return {
			usdtBalance: STRATEGY_CONFIG.initialUSDT,
			solHolding: 0,
			lastBuyPrice: null,
			totalSpent: 0,
			totalSoldUSDT: 0,
			consecutiveDcaBuys: 0,
			currentMonthReset: MONTH_KEY_FMT(new Date()),
			monthSpent: new Map(),
			sellStairsTriggered: new Set()
		};
	}

	/**
	 * 把 DO storage row (snake_case) 跟 D1 row 都映射到 portfolio 对象
	 */
	rowToPortfolio(row) {
		return {
			usdtBalance: row.usdt_balance,
			solHolding: row.sol_holding,
			lastBuyPrice: row.last_buy_price,
			totalSpent: row.total_spent,
			totalSoldUSDT: row.total_sold || 0,
			consecutiveDcaBuys: row.consecutive_dca_buys || 0,
			currentMonthReset: row.current_month_reset || MONTH_KEY_FMT(new Date()),
			monthSpent: new Map(),
			sellStairsTriggered: new Set(
				JSON.parse(row.sell_stairs_triggered || '[]')
			)
		};
	}

	/**
	 * D1 row (snake_case, 列名带 portfolio_state 前缀) → DO storage row shape
	 * 复用 rowToPortfolio 之前的逻辑
	 */
	d1RowToPortfolioRow(row) {
		return {
			usdt_balance: row.usdt_balance,
			sol_holding: row.sol_holding,
			last_buy_price: row.last_buy_price,
			total_spent: row.total_spent,
			total_sold: row.total_sold || 0,
			consecutive_dca_buys: row.consecutive_dca_buys || 0,
			current_month_reset: row.current_month_reset,
			sell_stairs_triggered: '[]' // D1 schema 没存这个字段, 启动时清空
		};
	}

	/**
	 * 持久化 portfolio — 双写 DO storage (热) + D1 (归档)
	 */
	async persistPortfolio() {
		if (!this.portfolio) return;
		const p = this.portfolio;
		const monthSpentTotal = Array.from(p.monthSpent.values()).reduce((a, b) => a + b, 0);
		const sellStairsJson = JSON.stringify(Array.from(p.sellStairsTriggered).sort());
		const updatedAt = new Date().toISOString();

		// 1) DO storage (主)
		try {
			this.state.storage.sql.exec(
				`INSERT OR REPLACE INTO portfolio
				 (id, usdt_balance, sol_holding, last_buy_price, total_spent, total_sold,
				  current_month_spent, current_month_reset, consecutive_dca_buys,
				  sell_stairs_triggered, updated_at)
				 VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				p.usdtBalance,
				p.solHolding,
				p.lastBuyPrice,
				p.totalSpent,
				p.totalSoldUSDT || 0,
				monthSpentTotal,
				p.currentMonthReset,
				p.consecutiveDcaBuys,
				sellStairsJson,
				updatedAt
			);
		} catch (err) {
			console.error('[TickerHub] DO storage portfolio write failed:', err);
			this.broadcastBrowser({
				type: 'error',
				action: 'persist_portfolio',
				message: `DO storage portfolio 写入失败: ${err.message}`
			});
		}

		// 2) D1 归档 (副, 失败不影响主)
		if (this.env.SOL_DCA_DB) {
			try {
				await this.env.SOL_DCA_DB.prepare(
					`INSERT OR REPLACE INTO portfolio_state
					 (id, usdt_balance, sol_holding, avg_buy_price, last_buy_price, last_buy_date,
					  total_spent, total_sold, current_month_spent, current_month_reset,
					  consecutive_dca_buys, updated_at)
					 VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
				)
					.bind(
						1,
						p.usdtBalance,
						p.solHolding,
						p.lastBuyPrice,
						p.lastBuyPrice,
						p.lastBuyPrice ? updatedAt.slice(0, 10) : null,
						p.totalSpent,
						p.totalSoldUSDT || 0,
						monthSpentTotal,
						p.currentMonthReset,
						p.consecutiveDcaBuys,
						updatedAt
					)
					.run();
			} catch (err) {
				console.error('[TickerHub] D1 portfolio archive failed:', err);
			}
		}
	}

	/**
	 * 启 OKX public WS
	 */
	connectOkx() {
		this.lastOkxWsState = 'connecting';
		try {
			const handle = subscribeTicker(this.publicWsUrl, this.channel, this.instId, {
				onOpen: () => {
					this.lastOkxWsState = 'open';
					console.log('[TickerHub] OKX WS connected');
					this.sendAlertSafe('info', 'OKX WS connected', `订阅 ${this.instId} ticker`);
				},
				onTicker: (d) => this.onOkxTicker(d),
				onError: (err) => {
					this.lastOkxWsState = 'error';
					console.error('[TickerHub] OKX WS error:', err);
					this.sendAlertSafe('error', 'OKX WS error', err.message);
				},
				onClose: (code, reason) => {
					this.lastOkxWsState = 'closed';
					console.log(`[TickerHub] OKX WS closed: ${code} ${reason}`);
					this.sendAlertSafe('warn', 'OKX WS closed', `code=${code} reason=${reason}`);
					if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
					this.reconnectTimer = setTimeout(() => this.connectOkx(), WS_RECONNECT_MS);
				}
			});
			this.okxWs = handle;
		} catch (err) {
			console.error('[TickerHub] connectOkx failed:', err);
			this.lastOkxWsState = 'error';
			this.sendAlertSafe('error', 'OKX WS connect failed', err.message);
		}
	}

	/**
	 * 处理 OKX ticker 推送
	 */
	async onOkxTicker(d) {
		this.lastTickerAt = Date.now();
		this.lastTickerPrice = parseFloat(d.last);

		// 1) 推给所有 browser（实时价格）
		this.broadcastBrowser({
			type: 'ticker',
			price: this.lastTickerPrice,
			open24h: parseFloat(d.open24h),
			high24h: parseFloat(d.high24h),
			low24h: parseFloat(d.low24h),
			ts: parseInt(d.ts)
		});

		// 2) 调策略
		if (this.isPaused) return;
		if (isSabbath()) return;
		if (!this.portfolio) return;

		const todayMonthKey = MONTH_KEY_FMT(new Date());
		maybeResetMonth(this.portfolio, todayMonthKey);

		const decision = decide(
			{ last: this.lastTickerPrice, open24h: parseFloat(d.open24h), ts: parseInt(d.ts) },
			this.portfolio,
			todayMonthKey
		);

		// 3) Hold: 不写 storage, 不广播, 只在内存 hold 环形缓冲累积 (前端 fold count 用)
		if (decision.action === 'hold') {
			const holdSignal = {
				id: crypto.randomUUID(),
				price: this.lastTickerPrice,
				action: 'hold',
				reason: decision.reason,
				drawdown_pct: decision.drawdownPct ?? null,
				profit_pct: decision.profitPct ?? null,
				usdt_after: this.portfolio.usdtBalance,
				sol_after: this.portfolio.solHolding,
				mode: this.okx.creds.isDemo ? 'demo' : 'live',
				created_at: new Date().toISOString()
			};
			this.recentHoldSignals.unshift(holdSignal);
			if (this.recentHoldSignals.length > SIGNAL_FIFO_LIMIT) {
				this.recentHoldSignals.length = SIGNAL_FIFO_LIMIT;
			}
			return;
		}

		// 4) Buy / Sell: 写 DO storage + D1 归档 + 广播
		const signal = {
			id: crypto.randomUUID(),
			price: this.lastTickerPrice,
			action: decision.action,
			reason: decision.reason,
			drawdown_pct: decision.drawdownPct ?? null,
			profit_pct: decision.profitPct ?? null,
			usdt_after: this.portfolio.usdtBalance,
			sol_after: this.portfolio.solHolding,
			mode: this.okx.creds.isDemo ? 'demo' : 'live',
			created_at: new Date().toISOString()
		};
		await this.persistSignal(signal);
		this.broadcastBrowser({ type: 'signal', ...signal });

		// 5) 执行 buy / sell
		if (decision.action === 'buy' && decision.amountUsdt >= 1) {
			await this.executeBuy(decision, signal);
		} else if (decision.action === 'sell' && decision.amountSol >= 0.001) {
			await this.executeSell(decision, signal);
		}
	}

	async executeBuy(decision, signal) {
		if (this.missingCredentials.length > 0) {
			this.broadcastBrowser({
				type: 'error',
				action: 'credentials_missing',
				message: `Cannot BUY: OKX credentials missing (${this.missingCredentials.join(', ')}). Put via 'wrangler secret put' or write to do-worker/.dev.vars.`
			});
			return;
		}
		// OKX V5 clOrdId: 1-32 位 alphanumeric (a-zA-Z0-9), 不能含 - 或 _
		const clOrdId = `solDca${Date.now()}${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`;
		try {
			// 用 lastTickerPrice 估算 sz,省一次 /api/v5/market/ticker round trip (~50ms)
			const res = await this.okx.marketBuy(this.instId, decision.amountUsdt, clOrdId, this.lastTickerPrice);
			const ordId = res?.[0]?.ordId;
			const solBought = decision.amountUsdt / this.lastTickerPrice;
			applyBuy(this.portfolio, decision.amountUsdt, solBought, this.lastTickerPrice, MONTH_KEY_FMT(new Date()));
			await this.persistPortfolio();
			const trade = {
				id: crypto.randomUUID(),
				cl_ord_id: clOrdId,
				side: 'buy',
				price: this.lastTickerPrice,
				amount_usdt: decision.amountUsdt,
				amount_sol: solBought,
				reason: decision.reason,
				drawdown_pct: decision.drawdownPct,
				multiplier: decision.multiplier,
				mode: this.okx.creds.isDemo ? 'demo' : 'live',
				okx_order_id: ordId,
				okx_state: 'filled',
				created_at: new Date().toISOString()
			};
			await this.persistTrade(trade);
			this.broadcastBrowser({ type: 'trade', side: 'buy', amountUsdt: decision.amountUsdt, price: this.lastTickerPrice, reason: decision.reason });
			this.sendAlertSafe('info', 'BUY executed', `${decision.reason} @ $${this.lastTickerPrice.toFixed(2)}`);
		} catch (err) {
			console.error('[TickerHub] buy failed:', err);
			this.sendAlertSafe('error', 'BUY failed', err.message);
			this.broadcastBrowser({ type: 'error', action: 'buy', message: err.message });
		}
	}

	async executeSell(decision, signal) {
		if (this.missingCredentials.length > 0) {
			this.broadcastBrowser({
				type: 'error',
				action: 'credentials_missing',
				message: `Cannot SELL: OKX credentials missing (${this.missingCredentials.join(', ')}).`
			});
			return;
		}
		// OKX V5 clOrdId: 1-32 位 alphanumeric
		const clOrdId = `solDca${Date.now()}${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`;
		try {
			const res = await this.okx.marketSell(this.instId, decision.amountSol, clOrdId);
			const ordId = res?.[0]?.ordId;
			applySell(this.portfolio, decision.amountUsdt, decision.amountSol, decision.stairIdx);
			await this.persistPortfolio();
			const trade = {
				id: crypto.randomUUID(),
				cl_ord_id: clOrdId,
				side: 'sell',
				price: this.lastTickerPrice,
				amount_usdt: decision.amountUsdt,
				amount_sol: decision.amountSol,
				reason: decision.reason,
				profit_pct: decision.profitPct,
				mode: this.okx.creds.isDemo ? 'demo' : 'live',
				okx_order_id: ordId,
				okx_state: 'filled',
				created_at: new Date().toISOString()
			};
			await this.persistTrade(trade);
			this.broadcastBrowser({ type: 'trade', side: 'sell', amountSol: decision.amountSol, price: this.lastTickerPrice, reason: decision.reason });
			this.sendAlertSafe('info', 'SELL executed', `${decision.reason} @ $${this.lastTickerPrice.toFixed(2)}`);
		} catch (err) {
			console.error('[TickerHub] sell failed:', err);
			this.sendAlertSafe('error', 'SELL failed', err.message);
			this.broadcastBrowser({ type: 'error', action: 'sell', message: err.message });
		}
	}

	/**
	 * 写 signal — DO storage (热, FIFO 50) + D1 (归档)
	 */
	async persistSignal(signal) {
		// 1) DO storage
		try {
			this.state.storage.sql.exec(
				`INSERT OR REPLACE INTO signals
				 (id, price, action, reason, drawdown_pct, profit_pct, usdt_after, sol_after, mode, created_at)
				 VALUES (?,?,?,?,?,?,?,?,?,?)`,
				signal.id,
				signal.price,
				signal.action,
				signal.reason,
				signal.drawdown_pct,
				signal.profit_pct,
				signal.usdt_after,
				signal.sol_after,
				signal.mode,
				signal.created_at
			);
			// FIFO 限 50
			const count = this.state.storage.sql.exec('SELECT COUNT(*) AS c FROM signals').one().c;
			if (count > SIGNAL_FIFO_LIMIT) {
				this.state.storage.sql.exec(
					`DELETE FROM signals WHERE id IN (
						SELECT id FROM signals ORDER BY created_at ASC LIMIT ?
					)`,
					count - SIGNAL_FIFO_LIMIT
				);
			}
		} catch (err) {
			console.error('[TickerHub] DO storage signal write failed:', err);
			this.broadcastBrowser({
				type: 'error',
				action: 'persist_signal',
				message: `DO storage signal 写入失败: ${err.message}`
			});
		}

		// 2) D1 归档
		if (this.env.SOL_DCA_DB) {
			try {
				await this.env.SOL_DCA_DB.prepare(
					`INSERT INTO signals (id, price, action, reason, drawdown_pct, profit_pct, usdt_after, sol_after, mode, created_at)
					 VALUES (?,?,?,?,?,?,?,?,?,?)`
				)
					.bind(
						signal.id,
						signal.price,
						signal.action,
						signal.reason,
						signal.drawdown_pct,
						signal.profit_pct,
						signal.usdt_after,
						signal.sol_after,
						signal.mode,
						signal.created_at
					)
					.run();
			} catch (err) {
				console.error('[TickerHub] D1 signal archive failed:', err);
			}
		}
	}

	/**
	 * 写 trade — DO storage (热, FIFO 30) + D1 (归档)
	 */
	async persistTrade(trade) {
		// 1) DO storage
		try {
			this.state.storage.sql.exec(
				`INSERT OR REPLACE INTO trades
				 (id, cl_ord_id, side, price, amount_usdt, amount_sol, reason, drawdown_pct, multiplier, profit_pct, mode, okx_order_id, okx_state, created_at)
				 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
				trade.id,
				trade.cl_ord_id,
				trade.side,
				trade.price,
				trade.amount_usdt,
				trade.amount_sol,
				trade.reason,
				trade.drawdown_pct ?? null,
				trade.multiplier ?? null,
				trade.profit_pct ?? null,
				trade.mode,
				trade.okx_order_id ?? null,
				trade.okx_state ?? null,
				trade.created_at
			);
			// FIFO 限 30
			const count = this.state.storage.sql.exec('SELECT COUNT(*) AS c FROM trades').one().c;
			if (count > TRADE_FIFO_LIMIT) {
				this.state.storage.sql.exec(
					`DELETE FROM trades WHERE id IN (
						SELECT id FROM trades ORDER BY created_at ASC LIMIT ?
					)`,
					count - TRADE_FIFO_LIMIT
				);
			}
		} catch (err) {
			console.error('[TickerHub] DO storage trade write failed:', err);
			this.broadcastBrowser({
				type: 'error',
				action: 'persist_trade',
				message: `DO storage trade 写入失败: ${err.message}`
			});
		}

		// 2) D1 归档
		if (this.env.SOL_DCA_DB) {
			try {
				await this.env.SOL_DCA_DB.prepare(
					`INSERT OR REPLACE INTO trades
					 (id, cl_ord_id, side, price, amount_usdt, amount_sol, reason, drawdown_pct, multiplier, profit_pct, mode, okx_order_id, okx_state, created_at)
					 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
				)
					.bind(
						trade.id,
						trade.cl_ord_id,
						trade.side,
						trade.price,
						trade.amount_usdt,
						trade.amount_sol,
						trade.reason,
						trade.drawdown_pct ?? null,
						trade.multiplier ?? null,
						trade.profit_pct ?? null,
						trade.mode,
						trade.okx_order_id ?? null,
						trade.okx_state ?? null,
						trade.created_at
					)
					.run();
			} catch (err) {
				console.error('[TickerHub] D1 trade archive failed:', err);
			}
		}
	}

	/**
	 * 读最近 N 条 signals (合并 buy/sell 持久化 + 内存 hold)
	 */
	getRecentSignals(limit = 20) {
		const persisted = this.state.storage.sql
			.exec('SELECT * FROM signals ORDER BY created_at DESC LIMIT ?', limit)
			.toArray();
		// 把内存 hold (不进 storage) 合并到列表 (前端显示 fold count)
		return [...this.recentHoldSignals, ...persisted].slice(0, limit);
	}

	/**
	 * 读最近 N 条 trades (DO storage)
	 */
	getRecentTrades(limit = 30) {
		return this.state.storage.sql
			.exec('SELECT * FROM trades ORDER BY created_at DESC LIMIT ?', limit)
			.toArray();
	}

	/**
	 * 心跳：监控 ticker 静默 + 跨月重置 + OKX 余额同步
	 */
	startHeartbeat() {
		this.heartbeatTimer = setInterval(() => {
			// 1) ticker 静默检查
			if (
				this.lastTickerAt > 0 &&
				Date.now() - this.lastTickerAt > TICKER_TIMEOUT_MS &&
				this.lastOkxWsState === 'open'
			) {
				this.sendAlertSafe('warn', 'Ticker silent', `${TICKER_TIMEOUT_MS / 1000}s 没收到 ticker`);
			}
			// 2) 跨月重置
			if (this.portfolio) {
				const todayKey = MONTH_KEY_FMT(new Date());
				if (this.portfolio.currentMonthReset !== todayKey) {
					this.portfolio.currentMonthReset = todayKey;
					this.portfolio.monthSpent = new Map();
					this.persistPortfolio().catch(console.error);
				}
			}
		}, 10_000);

		// 3) OKX 余额同步: 每 5 分钟一次
		//    只更新 usdtBalance + solHolding, 不动 lastBuyPrice / totalSpent / sellStairs
		this.balanceSyncTimer = setInterval(() => {
			if (this.missingCredentials.length > 0) return;
			if (!this.portfolio) return;
			Promise.all([
				this.okx.getUsdtBalance().catch((e) => {
					console.error('[TickerHub] balance sync usdt failed:', e);
					return null;
				}),
				this.okx.getSolBalance().catch((e) => {
					console.error('[TickerHub] balance sync sol failed:', e);
					return null;
				})
			]).then(([usdt, sol]) => {
				if (usdt != null) this.portfolio.usdtBalance = usdt;
				if (sol != null) this.portfolio.solHolding = sol;
				this.persistPortfolio().catch(console.error);
				this.broadcastBrowser({
					type: 'portfolio_synced',
					usdtBalance: this.portfolio.usdtBalance,
					solHolding: this.portfolio.solHolding
				});
			});
		}, BALANCE_SYNC_MS);
	}

	/**
	 * 广播给所有 browser WS
	 */
	broadcastBrowser(payload) {
		const json = JSON.stringify(payload);
		for (const ws of this.state.getWebSockets()) {
			try {
				ws.send(json);
			} catch (err) {
				console.error('[TickerHub] broadcast failed:', err);
			}
		}
	}

	/**
	 * 报警（带 try-catch）
	 */
	sendAlertSafe(level, title, body) {
		sendAlert(this.alertUrl, title, body, level).catch((err) =>
			console.error('[TickerHub] alert failed:', err)
		);
	}

	/**
	 * 路由分发
	 */
	async fetch(request) {
		const url = new URL(request.url);
		const path = url.pathname;

		// 懒初始化
		if (!this.portfolio) {
			await this.initialize();
		}

		// WS upgrade
		if (request.headers.get('Upgrade') === 'websocket') {
			const pair = new WebSocketPair();
			const [client, server] = [pair[0], pair[1]];
			this.state.acceptWebSocket(server);
			try {
				server.send(
					JSON.stringify({
						type: 'hello',
						portfolio: this.portfolio ? this.snapshotPortfolio() : null,
						paused: this.isPaused,
						okxWsState: this.lastOkxWsState,
						lastTickerPrice: this.lastTickerPrice,
						lastTickerAt: this.lastTickerAt,
						missingCredentials: this.missingCredentials,
						ts: Date.now()
					})
				);
			} catch (_) {}
			return new Response(null, { status: 101, webSocket: client });
		}

		if (path === '/state' && request.method === 'GET') {
			return Response.json({
				portfolio: this.portfolio ? this.snapshotPortfolio() : null,
				paused: this.isPaused,
				okxWsState: this.lastOkxWsState,
				lastTickerPrice: this.lastTickerPrice,
				lastTickerAt: this.lastTickerAt,
				recentSignals: this.getRecentSignals(20),
				recentTrades: this.getRecentTrades(30),
				sabbath: isSabbath(),
				missingCredentials: this.missingCredentials,
				ts: Date.now()
			});
		}

		// /recent_signals 和 /recent_trades — 给 frontend /api/{signals,trades} 在 dev 走 service binding 用
		if ((path === '/recent_signals' || path === '/recent_trades') && request.method === 'GET') {
			const limit = Math.min(parseInt(url.searchParams.get('limit') || '50'), 200);
			if (path === '/recent_signals') {
				return Response.json({ signals: this.getRecentSignals(limit) });
			}
			return Response.json({ trades: this.getRecentTrades(limit) });
		}

		if (path === '/control' && request.method === 'POST') {
			let body;
			try {
				body = await request.json();
			} catch {
				return new Response('invalid json', { status: 400 });
			}
			const action = body.action;
			if (action === 'pause') {
				this.isPaused = true;
				this.broadcastBrowser({ type: 'paused', paused: true });
				return Response.json({ ok: true, paused: true });
			}
			if (action === 'resume') {
				this.isPaused = false;
				this.broadcastBrowser({ type: 'paused', paused: false });
				return Response.json({ ok: true, paused: false });
			}
			if (action === 'init_dca') {
				if (this.missingCredentials.length > 0) {
					return Response.json(
						{ ok: false, error: 'OKX credentials missing — cannot init DCA' },
						{ status: 503 }
					);
				}
				if (this.portfolio.lastBuyPrice !== null) {
					return Response.json(
						{ ok: false, error: 'DCA already initialized (lastBuyPrice exists)' },
						{ status: 409 }
					);
				}
				const baseAmount = STRATEGY_CONFIG.baseAmount;
				const decision = {
					action: 'buy',
					amountUsdt: baseAmount,
					reason: `手动 Start DCA:首买 $${baseAmount} 建立基准价`,
					drawdownPct: null,
					multiplier: 1
				};
				const signal = {
					id: crypto.randomUUID(),
					price: this.lastTickerPrice,
					action: 'buy',
					reason: decision.reason,
					drawdown_pct: null,
					profit_pct: null,
					usdt_after: this.portfolio.usdtBalance,
					sol_after: this.portfolio.solHolding,
					mode: this.okx.creds.isDemo ? 'demo' : 'live',
					created_at: new Date().toISOString()
				};
				await this.persistSignal(signal);
				this.broadcastBrowser({ type: 'signal', ...signal });
				await this.executeBuy(decision, signal);
				return Response.json({ ok: true });
			}
			if (action === 'manual_sell' && body.amountSol) {
				if (this.missingCredentials.length > 0) {
					return Response.json(
						{ ok: false, error: 'OKX credentials missing' },
						{ status: 503 }
					);
				}
				const clOrdId = `solDcaM${Date.now()}${crypto.randomUUID().replace(/-/g, '').slice(0, 6)}`;
				try {
					await this.okx.marketSell(this.instId, body.amountSol, clOrdId);
					const usdtGot = body.amountSol * this.lastTickerPrice;
					this.portfolio.solHolding = Math.max(0, this.portfolio.solHolding - body.amountSol);
					this.portfolio.usdtBalance += usdtGot;
					await this.persistPortfolio();
					this.broadcastBrowser({ type: 'manual_sell_done', amountSol: body.amountSol });
					return Response.json({ ok: true });
				} catch (err) {
					return Response.json({ ok: false, error: String(err) }, { status: 500 });
				}
			}
			return new Response('unknown action', { status: 400 });
		}

		return new Response('not found', { status: 404 });
	}

	snapshotPortfolio() {
		const p = this.portfolio;
		return {
			usdtBalance: p.usdtBalance,
			solHolding: p.solHolding,
			lastBuyPrice: p.lastBuyPrice,
			totalSpent: p.totalSpent,
			totalSoldUSDT: p.totalSoldUSDT || 0,
			consecutiveDcaBuys: p.consecutiveDcaBuys,
			currentMonthReset: p.currentMonthReset,
			monthSpentThisMonth: p.monthSpent.get(MONTH_KEY_FMT(new Date())) || 0,
			sellStairsTriggered: Array.from(p.sellStairsTriggered),
			currentValue: p.usdtBalance + p.solHolding * this.lastTickerPrice,
			profit: p.usdtBalance + p.solHolding * this.lastTickerPrice - STRATEGY_CONFIG.initialUSDT,
			profitPct:
				((p.usdtBalance + p.solHolding * this.lastTickerPrice - STRATEGY_CONFIG.initialUSDT) /
					STRATEGY_CONFIG.initialUSDT) *
				100
		};
	}

	// === Hibernation API handlers ===

	async webSocketMessage(ws, message) {
		try {
			const text = typeof message === 'string' ? message : new TextDecoder().decode(message);
			const msg = JSON.parse(text);
			if (msg.type === 'ping') {
				ws.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
			}
		} catch (err) {
			console.error('[TickerHub] ws message parse failed:', err);
		}
	}

	async webSocketClose(ws, code, reason, wasClean) {
		try {
			ws.close(code || 1000, reason || 'client_close');
		} catch (_) {}
	}

	async webSocketError(ws, error) {
		console.error('[TickerHub] browser WS error:', error);
	}
}
