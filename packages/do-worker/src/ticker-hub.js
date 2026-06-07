/**
 * TickerHub Durable Object
 *
 * 责任：
 * 1. 持有 1 个 OKX public WS（订阅 SOL-USDT ticker）
 * 2. 持有 N 个 browser WS（Hibernation API 持久化）
 * 3. ticker 推送 → 调 strategy.decide() → OKX private API 下单
 * 4. 写 portfolio + signals + trades:
 *    - DO 内置 sqlite (state.storage.sql) 做热数据, ~ms 写, FIFO 50/30
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
// (已删 BALANCE_SYNC_MS — balance sync 不再后台跑, 见 loadPortfolio 注释)
const MONTH_KEY_FMT = (d) => d.toISOString().slice(0, 7); // YYYY-MM

// FIFO 上限: signals 50 条, trades 30 条
const SIGNAL_FIFO_LIMIT = 50;
const TRADE_FIFO_LIMIT = 30;

// Hold 信号 rate limit: OKX ticker 每秒推 ~10 次, 每个 tick 都记 hold 会刷屏
//   - 至少 HOLD_HEARTBEAT_MS (30s) 间隔 (心跳)
//   - 或价格相对上次记录的 hold 移动 > HOLD_PRICE_CHANGE_PCT (0.2%) — 立即补一条 (波动市)
//   - Buy/Sell/Skip 不限流, 立刻记
const HOLD_HEARTBEAT_MS = 30_000;
const HOLD_PRICE_CHANGE_PCT = 0.2;

// DO storage schema (跟 D1 portfolio_state / signals / trades 三张表完全对齐, 字段/名字/snake_case 一致)
//   单一 source of truth: packages/do-worker/src/db/schema.js (Drizzle) → drizzle/migrations/0000_initial.sql → D1
//   worker raw SQL 写 DO + D1 都按这个 schema 走, 避免 silent drift (2026-06-07 fix)
const SQL_SCHEMA = `
	CREATE TABLE IF NOT EXISTS portfolio_state (
		id INTEGER PRIMARY KEY,
		usdt_balance REAL NOT NULL DEFAULT 0,
		sol_holding REAL NOT NULL DEFAULT 0,
		avg_buy_price REAL,
		last_buy_price REAL,
		total_spent REAL NOT NULL DEFAULT 0,
		total_sold REAL NOT NULL DEFAULT 0,
		realized_pnl REAL NOT NULL DEFAULT 0,
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
		okx_fee TEXT,
		intended_amount_usdt REAL,
		created_at TEXT NOT NULL
	);
	CREATE INDEX IF NOT EXISTS idx_signals_created_at ON signals (created_at DESC);
	CREATE INDEX IF NOT EXISTS idx_trades_created_at ON trades (created_at DESC);
	CREATE TABLE IF NOT EXISTS alert_cooldowns (
		key TEXT PRIMARY KEY,
		last_sent INTEGER NOT NULL
	);
`;

// 兼容老 DO storage — user 要求 destructive 重建, 不 ALTER 加列
// DROP + CREATE 三个表 (portfolio_state / signals / trades), 历史数据直接清掉
// (2026-06-07 决策: 不需要历史 trades, 重建更稳, 避免 schema drift)
const SCHEMA_REBUILD = [
	'DROP TABLE IF EXISTS portfolio_state',
	'DROP TABLE IF EXISTS signals',
	'DROP TABLE IF EXISTS trades',
	'DROP TABLE IF EXISTS alert_cooldowns'
];

/** @param {any} storage DO SQLite storage */
export function applyMigrations(storage) {
	// Destructive 重建: 先 DROP 老表 (IF EXISTS), 让后面 SQL_SCHEMA 里的 CREATE TABLE IF NOT EXISTS
	// 用新 schema 建 — 老 schema 数据全部清空 (2026-06-07 user 决策, 不需要历史)
	for (const sql of SCHEMA_REBUILD) {
		try {
			storage.sql.exec(sql);
		} catch (err) {
			console.error('[TickerHub] DROP failed:', sql, err);
		}
	}
	// 跑 SQL_SCHEMA (CREATE TABLE IF NOT EXISTS) — 现在 IF NOT EXISTS 触发新表建立
	try {
		storage.sql.exec(SQL_SCHEMA);
	} catch (err) {
		console.error('[TickerHub] CREATE TABLE failed:', err);
	}
}

export class TickerHub {
	/**
	 * @param {DurableObjectState} state
	 * @param {Env} env
	 */
	constructor(state, env) {
		this.state = state;
		this.env = env;
		// 兼容老 DO storage schema: 加新字段
		applyMigrations(state.storage);
		// 从 DO name 推 mode: 'sol-usdt-demo' → 'demo', 'sol-usdt-live' → 'live'
		//   index.js 路由会按 ?mode=... 选不同 DO name
		//   name 为 null (没经过 idFromName) → 兜底 demo
		const hubName = state.id?.name || '';
		this.mode = hubName.endsWith('-live') ? 'live' : 'demo';
		this.isDemo = this.mode === 'demo';
		// 每个 DO 拿对应 mode 的 credentials (跳过 env OKX_DEMO_MODE)
		this.okx = createOkxClient(env, this.isDemo);
		this.missingCredentials = checkOkxCredentials(env, this.isDemo);
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
		this.recentHoldSignals = []; // 内存 hold 环形缓冲 (前端 fold count 用, 不写 storage)
		this.lastHoldSignalAt = 0; // rate limit: 上次 emit hold 的 timestamp
		this.lastHoldSignalPrice = 0; // rate limit: 上次 emit hold 时的价格 (算价格变化用)

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
	 * 读 portfolio (优先 DO storage → OKX 真实余额 → 写死 7000)
	 */
	async loadPortfolio() {
		// demo 跟 live 各自用独立 row id (1 / 2), D1 schema 不加 mode 列
		const portfolioRowId = this.mode === 'live' ? 2 : 1;
		// 1) 优先从 DO storage 读 (热数据, ~ms)
		const rows = this.state.storage.sql
			.exec('SELECT * FROM portfolio_state WHERE id = ?', portfolioRowId)
			.toArray();
		if (rows.length > 0) {
			this.portfolio = this.rowToPortfolio(rows[0]);
			console.log(`[TickerHub] loaded portfolio (${this.mode}) from DO storage:`, JSON.stringify(this.portfolio));
			return;
		}

		// 2) 调 OKX 拿真实 demo 余额
		if (this.missingCredentials.length === 0) {
			try {
				const usdt = await this.okx.getUsdtBalance();
				const solRaw = await this.okx.getSolBalance();
				const solTruncated = Math.floor(solRaw * 1000000) / 1000000;
				this.portfolio = this.defaultPortfolio();
				this.portfolio.usdtBalance = usdt;
				this.portfolio.solHolding = solTruncated;
				await this.persistPortfolio();
				console.log(`[TickerHub] /state sync: OKX raw=${solRaw} → floor→${solTruncated} (6dp) | USDT=${usdt} | mode=${this.mode}`);
				return;
			} catch (err) {
				console.error('[TickerHub] OKX getBalance failed:', err);
			}
		}

		// 3) fallback: 写死 7000
		this.portfolio = this.defaultPortfolio();
		await this.persistPortfolio();
		console.warn('[TickerHub] using hardcoded 7000U default — OKX credentials missing or API failed');
	}

	defaultPortfolio() {
		return {
			usdtBalance: STRATEGY_CONFIG.initialUSDT,
			solHolding: 0,
			avgBuyPrice: null,
			realizedPnL: 0,
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
		// monthSpent 反序列化: 从 current_month_spent + current_month_reset 还原
		// DO storage 只存当月 scalar (跨月会被 heartbeat 重置, 历史月份不存)
		const monthSpent = new Map();
		if (row.current_month_reset && row.current_month_spent) {
			monthSpent.set(row.current_month_reset, row.current_month_spent);
		}
		return {
			usdtBalance: row.usdt_balance,
			solHolding: row.sol_holding,
			avgBuyPrice: row.avg_buy_price != null ? row.avg_buy_price : null,
			realizedPnL: row.realized_pnl || 0,
			lastBuyPrice: row.last_buy_price,
			totalSpent: row.total_spent,
			totalSoldUSDT: row.total_sold || 0,
			consecutiveDcaBuys: row.consecutive_dca_buys || 0,
			currentMonthReset: row.current_month_reset || MONTH_KEY_FMT(new Date()),
			monthSpent,
			sellStairsTriggered: new Set(
				JSON.parse(row.sell_stairs_triggered || '[]')
			)
		};
	}

	/**
	 * 持久化 portfolio — DO storage
	 */
	async persistPortfolio() {
		if (!this.portfolio) return;
		const p = this.portfolio;
		// demo 跟 live 各自用独立 row id (1 / 2), D1 schema 不加 mode 列
		const portfolioRowId = this.mode === 'live' ? 2 : 1;
		// monthSpentTotal 只算 currentMonthReset 月份 (跨月重置时其他月份不存, 避免数据膨胀)
		const monthSpentTotal = p.monthSpent.get(p.currentMonthReset) || 0;
		const sellStairsJson = JSON.stringify(Array.from(p.sellStairsTriggered).sort());
		const updatedAt = new Date().toISOString();

		// 1) DO storage (主)
		try {
			this.state.storage.sql.exec(
				`INSERT OR REPLACE INTO portfolio_state
				 (id, usdt_balance, sol_holding, avg_buy_price, last_buy_price, total_spent, total_sold,
				  realized_pnl, current_month_spent, current_month_reset, consecutive_dca_buys,
				  sell_stairs_triggered, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				portfolioRowId,
				p.usdtBalance,
				p.solHolding,
				p.avgBuyPrice,
				p.lastBuyPrice,
				p.totalSpent,
				p.totalSoldUSDT || 0,
				p.realizedPnL || 0,
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
			// Rate limit: 30s 心跳 OR 价格移动 > 0.2% 才记一条
			//   避免 OKX ticker 每秒 10 次推送刷屏 (FIFO 50 条本来 5 秒就刷一次)
			const now = Date.now();
			const elapsedMs = now - this.lastHoldSignalAt;
			const priceChangePct = this.lastHoldSignalPrice > 0
				? Math.abs((this.lastTickerPrice - this.lastHoldSignalPrice) / this.lastHoldSignalPrice) * 100
				: Infinity;
			if (elapsedMs < HOLD_HEARTBEAT_MS && priceChangePct < HOLD_PRICE_CHANGE_PCT) {
				// 限流: 不 emit
				return;
			}
			const holdSignal = {
				id: crypto.randomUUID(),
				price: this.lastTickerPrice,
				action: 'hold',
				reason: decision.reason,
				drawdown_pct: decision.drawdownPct ?? null,
				profit_pct: decision.profitPct ?? null,
				usdt_after: this.portfolio.usdtBalance,
				sol_after: this.portfolio.solHolding,
				mode: this.mode,
				created_at: new Date().toISOString()
			};
			this.recentHoldSignals.unshift(holdSignal);
			if (this.recentHoldSignals.length > SIGNAL_FIFO_LIMIT) {
				this.recentHoldSignals.length = SIGNAL_FIFO_LIMIT;
			}
			this.lastHoldSignalAt = now;
			this.lastHoldSignalPrice = this.lastTickerPrice;
			return;
		}

		// 4) Buy / Sell: 写 DO storage + 广播
		const signal = {
			id: crypto.randomUUID(),
			price: this.lastTickerPrice,
			action: decision.action,
			reason: decision.reason,
			drawdown_pct: decision.drawdownPct ?? null,
			profit_pct: decision.profitPct ?? null,
			usdt_after: this.portfolio.usdtBalance,
			sol_after: this.portfolio.solHolding,
			mode: this.mode,
			created_at: new Date().toISOString()
		};
		await this.persistSignal(signal);
		this.broadcastBrowser({ type: 'signal', ...signal });
		// 重置 hold rate limit: 下一条 hold 立刻 emit (让 user 看到 "buy/sell 之后回到 hold")
		this.lastHoldSignalAt = 0;
		this.lastHoldSignalPrice = 0;

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
		const clOrdId = `solDca${this.mode === 'live' ? 'L' : 'D'}${Date.now()}${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`;
		try {
			// 用 lastTickerPrice 估算 sz,省一次 /api/v5/market/ticker round trip (~50ms)
			const res = await this.okx.marketBuy(this.instId, decision.amountUsdt, clOrdId, this.lastTickerPrice);
			const ordId = res?.[0]?.ordId;
			if (!ordId) throw new Error('OKX order response missing ordId');

			// 下单后调 OKX 拿真实 fill (accFillSz / avgPx) — trade 表不再用预算值
			// 偶发 OKX 异步 fill 需要 retry 几次, market order 通常 ≤200ms
			let orderDetail = null;
			for (let i = 0; i < 3 && !orderDetail; i++) {
				orderDetail = await this.okx.getOrderDetail(this.instId, ordId);
				if (orderDetail && orderDetail.state === 'filled') break;
				await new Promise((r) => setTimeout(r, 100 * (i + 1)));
			}
			// 真实 fill 数据 (有就覆盖, 没有 fallback 到预算)
			const realFillSz = parseFloat(orderDetail?.accFillSz || '0');
			const realAvgPx = parseFloat(orderDetail?.avgPx || this.lastTickerPrice);
			const realFee = parseFloat(orderDetail?.fee || '0');
			const realFeeCcy = orderDetail?.feeCcy || '';
			const realAmountUsdt = +(realFillSz * realAvgPx).toFixed(2);
			const solBought = realFillSz > 0 ? realFillSz : decision.amountUsdt / this.lastTickerPrice;
			const usdtSpent = realAmountUsdt > 0 ? realAmountUsdt : decision.amountUsdt;

			applyBuy(this.portfolio, usdtSpent, solBought, realAvgPx, MONTH_KEY_FMT(new Date()));
			await this.persistPortfolio();
			const trade = {
				id: crypto.randomUUID(),
				cl_ord_id: clOrdId,
				side: 'buy',
				price: realAvgPx,
				amount_usdt: usdtSpent,
				amount_sol: solBought,
				reason: decision.reason,
				drawdown_pct: decision.drawdownPct,
				multiplier: decision.multiplier,
				mode: this.mode,
				okx_order_id: ordId,
				okx_state: orderDetail?.state || 'filled',
				okx_fee: realFeeCcy ? `${realFee} ${realFeeCcy}` : null,
				intended_amount_usdt: decision.amountUsdt, // 记录下单意图, audit 用
				created_at: new Date().toISOString()
			};
			await this.persistTrade(trade);
			this.broadcastBrowser({ type: 'trade', side: 'buy', amountUsdt: usdtSpent, price: realAvgPx, reason: decision.reason });
			this.sendAlertSafe('info', 'BUY executed', `${decision.reason} @ $${realAvgPx.toFixed(2)} — ${solBought} SOL ($${usdtSpent})`);
			// 下单成功后立即拉 OKX 真实余额, dashboard 跟账户实时对准
			await this.syncBalanceFromOkx();
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
		const clOrdId = `solDca${this.mode === 'live' ? 'L' : 'D'}${Date.now()}${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`;
		try {
			const res = await this.okx.marketSell(this.instId, decision.amountSol, clOrdId);
			const ordId = res?.[0]?.ordId;
			if (!ordId) throw new Error('OKX sell response missing ordId');

			// 拿真实 sell fill 数据 — 覆盖 trade 表预算值
			let orderDetail = null;
			for (let i = 0; i < 3 && !orderDetail; i++) {
				orderDetail = await this.okx.getOrderDetail(this.instId, ordId);
				if (orderDetail && orderDetail.state === 'filled') break;
				await new Promise((r) => setTimeout(r, 100 * (i + 1)));
			}
			const realFillSz = parseFloat(orderDetail?.accFillSz || '0');
			const realAvgPx = parseFloat(orderDetail?.avgPx || this.lastTickerPrice);
			const realFee = parseFloat(orderDetail?.fee || '0');
			const realFeeCcy = orderDetail?.feeCcy || '';
			const solSold = realFillSz > 0 ? realFillSz : decision.amountSol;
			const usdtGot = +(solSold * realAvgPx).toFixed(2);

			applySell(this.portfolio, usdtGot, solSold, decision.stairIdx);
			await this.persistPortfolio();
			const trade = {
				id: crypto.randomUUID(),
				cl_ord_id: clOrdId,
				side: 'sell',
				price: realAvgPx,
				amount_usdt: usdtGot,
				amount_sol: solSold,
				reason: decision.reason,
				profit_pct: decision.profitPct,
				mode: this.mode,
				okx_order_id: ordId,
				okx_state: orderDetail?.state || 'filled',
				okx_fee: realFeeCcy ? `${realFee} ${realFeeCcy}` : null,
				intended_amount_usdt: decision.amountUsdt, // 记录策略预期, audit 用
				created_at: new Date().toISOString()
			};
			await this.persistTrade(trade);
			this.broadcastBrowser({ type: 'trade', side: 'sell', amountSol: solSold, price: realAvgPx, reason: decision.reason });
			this.sendAlertSafe('info', 'SELL executed', `${decision.reason} @ $${realAvgPx.toFixed(2)} — ${solSold} SOL ($${usdtGot})`);
			// 卖单成功后立即拉 OKX 真实余额, dashboard 跟账户实时对准
			await this.syncBalanceFromOkx();
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

	}

	/**
	 * 写 trade — DO storage (热, FIFO 30) + D1 (归档)
	 */
	async persistTrade(trade) {
		// 1) DO storage
		try {
			this.state.storage.sql.exec(
				`INSERT OR REPLACE INTO trades
				 (id, cl_ord_id, side, price, amount_usdt, amount_sol, reason, drawdown_pct, multiplier, profit_pct, mode, okx_order_id, okx_state, okx_fee, intended_amount_usdt, created_at)
				 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
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
				trade.okx_fee ?? null,
				trade.intended_amount_usdt ?? null,
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

		// 3) OKX 余额同步: 不再后台跑 (见 loadPortfolio + syncBalanceFromOkx 注释)
		//    同步时机: 启动时 (loadPortfolio step 3) + 买/卖成功后 (executeBuy/executeSell/manual_sell)
		//    OKX 真实账户 = source of truth, DO storage = 策略历史 (lastBuyPrice / totalSpent 等)
	}

	/**
	 * 跟 OKX 真实账户同步 USDT + SOL 余额
	 * 失败不抛错 (只 log + 静默), 不影响主流程 (下单/卖单)
	 * 同步后会 broadcast portfolio_synced, dashboard 立即反映
	 */
	async syncBalanceFromOkx() {
		if (this.missingCredentials.length > 0) return;
		if (!this.portfolio) return;
		try {
			const [usdt, sol] = await Promise.all([
				this.okx.getUsdtBalance().catch((e) => {
					console.error('[TickerHub] sync usdt failed:', e);
					return null;
				}),
				this.okx.getSolBalance().catch((e) => {
					console.error('[TickerHub] sync sol failed:', e);
					return null;
				})
			]);
			if (usdt != null) this.portfolio.usdtBalance = usdt;
			if (sol != null) {
				const solTruncated = Math.floor(sol * 1000000) / 1000000;
				this.portfolio.solHolding = solTruncated;
				console.log(`[TickerHub] syncBalance: OKX raw=${sol} → floor→${solTruncated} (6dp) | USDT=${usdt} | mode=${this.mode}`);
			}
			await this.persistPortfolio();
			// 推送完整 portfolio 快照 (不是只 usdt/sol), 让前端 trade/init_dca 后能看到 lastBuyPrice/avgBuyPrice/totalSpent 变化
			this.broadcastBrowser({
				type: 'portfolio_synced',
				portfolio: this.snapshotPortfolio()
			});
			console.log(
				`[TickerHub] synced from OKX: ${this.portfolio.usdtBalance} USDT + ${this.portfolio.solHolding} SOL`
			);
		} catch (err) {
			console.error('[TickerHub] syncBalanceFromOkx failed:', err);
		}
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
	 * Cooldown 查 DO storage (state.storage.sql) — DO 重启后仍然有效
	 */
	sendAlertSafe(level, title, body) {
		const cooldownMs = { info: 5 * 60 * 1000, warn: 2 * 60 * 1000 }[level];
		if (cooldownMs) {
			const cooldownKey = `${level}:${title}`;
			const row = this.state.storage.sql
				.exec('SELECT last_sent FROM alert_cooldowns WHERE key = ?', cooldownKey)
				.toArray()[0];
			const lastSent = row?.last_sent || 0;
			if (Date.now() - lastSent < cooldownMs) return;
			this.state.storage.sql.exec(
				'INSERT OR REPLACE INTO alert_cooldowns (key, last_sent) VALUES (?, ?)',
				cooldownKey,
				Date.now()
			);
		}
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
						// 跟 /state 端点对齐, 避免页面刷新 / 模式切换时决策日志 + 最近成交丢失
						recentSignals: this.getRecentSignals(50),
						recentTrades: this.getRecentTrades(50),
						missingCredentials: this.missingCredentials,
						ts: Date.now()
					})
				);
			} catch (_) {}
			return new Response(null, { status: 101, webSocket: client });
		}

		if (path === '/state' && request.method === 'GET') {
			return Response.json({
				mode: this.mode,				portfolio: this.portfolio ? this.snapshotPortfolio() : null,
				paused: this.isPaused,
				okxWsState: this.lastOkxWsState,
				lastTickerPrice: this.lastTickerPrice,
				lastTickerAt: this.lastTickerAt,
				recentSignals: this.getRecentSignals(50),
				recentTrades: this.getRecentTrades(50),
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

		// /sync-balance — 手动触发 OKX 余额同步，返回完整 state (前端刷新按钮调用)
		if (path === '/sync-balance' && request.method === 'GET') {
			try {
				await this.syncBalanceFromOkx();
				return Response.json({
					ok: true,
					mode: this.mode,
					portfolio: this.portfolio ? this.snapshotPortfolio() : null,
					paused: this.isPaused,
					okxWsState: this.lastOkxWsState,
					lastTickerPrice: this.lastTickerPrice,
					lastTickerAt: this.lastTickerAt,
					recentSignals: this.getRecentSignals(50),
					recentTrades: this.getRecentTrades(50),
					sabbath: isSabbath(),
					missingCredentials: this.missingCredentials,
					ts: Date.now()
				});
			} catch (err) {
				console.error('[TickerHub] /sync-balance failed:', err);
				return Response.json({ ok: false, error: err.message }, { status: 500 });
			}
		}

		// /debug/okx-balance — 直接调 OKX getBalance, 返回原始响应 (debug 用)
		if (path === '/debug/okx-balance' && request.method === 'GET') {
			try {
				const data = await this.okx.getBalance();
				// 同时 parse 出 usdt/sol, 跟 portfolio snapshot 比对
				const usdtEntry = data.find((d) => d.ccy === 'USDT');
				const solEntry = data.find((d) => d.ccy === 'SOL');
			return Response.json({
					ok: true,
					mode: this.mode,
					balance: data,
					parsed: {
						usdt: usdtEntry ? parseFloat(usdtEntry.availBal) : null,
						sol: solEntry ? parseFloat(solEntry.availBal) : null
					},
					missingCredentials: this.missingCredentials
				});
			} catch (err) {
				return Response.json({ ok: false, error: String(err), mode: this.mode }, { status: 500 });
			}
		}

		// /reset — 清 DO storage portfolio_state, 重新拉 OKX 真实账户
		//   use case: 切 live 模式, 历史 demo 脏数据污染计算
		if (path === '/reset' && request.method === 'POST') {
			let soldSol = 0;
			let usdtGot = 0;
			let sellError = null;
			try {
				// 1) 先卖光所有 SOL 换成 USDT (user 要求 reset 走这条路)
				if (this.missingCredentials.length === 0) {
					try {
						// 优先用 OKX 真实余额，避免 DO state 精度累积误差（DO 里 0.4627，OKX 里 0.462 导致 sell 失败）
						const okxSolBalance = await this.okx.getSolBalance();
						const doStateSolBalance = this.portfolio?.solHolding ?? 0;
						console.log(
							`[TickerHub] reset: OKX availSol=${okxSolBalance}, DO state solHolding=${doStateSolBalance}, ` +
							`mode=${this.mode}`
						);
						// 直接截 6 位，不用 0.999 buffer（精度已在 OKX sync 时统一截好）
						const solBalance = Math.round(okxSolBalance * 1000000) / 1000000;
						if (solBalance > 0.001) {
							// 1a) 算这次清理卖出的 realizedPnL (用当前 portfolio avgBuyPrice, 不更新到 portfolio state)
							//   这次卖出后整个 state 清空, 所以这次 P&L 只作 audit / alert 输出, 不入 portfolio_state
							const cleanupRealized =
								this.portfolio?.avgBuyPrice != null
									? (this.lastTickerPrice - this.portfolio.avgBuyPrice) * solBalance
									: 0;
							const clOrdId = `solDcaR${this.mode === 'live' ? 'L' : 'D'}${Date.now()}${crypto.randomUUID().replace(/-/g, '').slice(0, 6)}`;
							await this.okx.marketSell(this.instId, solBalance, clOrdId);
							soldSol = solBalance;
							usdtGot = solBalance * this.lastTickerPrice;
							console.log(
								`[TickerHub] reset sold ${soldSol} SOL for ~$${usdtGot.toFixed(2)} (cleanup realized ≈ $${cleanupRealized.toFixed(2)})`
							);
							this.sendAlertSafe(
								'info',
								'RESET sold SOL',
								`${soldSol.toFixed(4)} SOL → ~$${usdtGot.toFixed(2)} USDT @ $${this.lastTickerPrice.toFixed(2)}`
							);
							await this.syncBalanceFromOkx();
						}
					} catch (sellErr) {
						sellError = `sell 失败（OKX 余额不足）: ${sellErr.message}`;
						console.warn('[TickerHub] reset sell failed:', sellErr.message);
						// 不 throw，让 reset 继续 — sell 失败不影响清空 DO state
					}
				}
				// demo / live 各自用独立 row id (1 / 2), D1 schema 不加 mode 列
				const portfolioRowId = this.mode === 'live' ? 2 : 1;
				this.state.storage.sql.exec('DELETE FROM portfolio_state WHERE id = ?', portfolioRowId);
				this.state.storage.sql.exec('DELETE FROM signals WHERE mode = ?', this.mode);
				this.state.storage.sql.exec('DELETE FROM trades WHERE mode = ?', this.mode);
				this.portfolio = null;
				await this.loadPortfolio();
			// 清 hold 内存缓冲 + rate limit 状态
			this.recentHoldSignals = [];
			this.lastHoldSignalAt = 0;
			this.lastHoldSignalPrice = 0;
			// 如果 sell 失败，不强制清 solHolding — 让 loadPortfolio() 拉到的 OKX 真实余额生效
			// 如果 sell 成功，loadPortfolio() 会用 syncBalanceFromOkx() 更新余额，两者都对
			if (this.portfolio) {
				this.portfolio = {
					...this.portfolio,
					avgBuyPrice: null,
					lastBuyPrice: null,
					totalSpent: 0,
					totalSoldUSDT: 0,
					realizedPnL: 0,
					consecutiveDcaBuys: 0,
					sellStairsTriggered: new Set(),
					monthSpent: new Map(),
					currentMonthReset: MONTH_KEY_FMT(new Date())
				};
				}
				await this.persistPortfolio();
				this.broadcastBrowser({
					type: 'portfolio_reset',
					portfolio: this.snapshotPortfolio(),
					soldSol,
					usdtGot,
					sellError
				});
				console.log(`[TickerHub] reset complete — sold ${soldSol} SOL, usdt now ${this.portfolio.usdtBalance}`);
				return Response.json({ ok: true, portfolio: this.snapshotPortfolio(), soldSol, usdtGot, sellError });
			} catch (err) {
				console.error('[TickerHub] reset failed:', err);
				return Response.json({ ok: false, error: String(err) }, { status: 500 });
			}
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
					mode: this.mode,
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
				const clOrdId = `solDcaM${this.mode === 'live' ? 'L' : 'D'}${Date.now()}${crypto.randomUUID().replace(/-/g, '').slice(0, 6)}`;
				try {
					await this.okx.marketSell(this.instId, body.amountSol, clOrdId);
					const usdtGot = body.amountSol * this.lastTickerPrice;
					this.portfolio.solHolding = Math.max(0, this.portfolio.solHolding - body.amountSol);
					this.portfolio.usdtBalance += usdtGot;
					await this.persistPortfolio();
					this.broadcastBrowser({ type: 'manual_sell_done', amountSol: body.amountSol });
					// 卖成功后立即拉 OKX 真实余额, dashboard 跟账户实时对准
					await this.syncBalanceFromOkx();
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
		// 持仓浮盈: (现价 - 平均买入价) × 持仓数
		//   没买入过 (avgBuyPrice=null) 或 已清仓 (solHolding<dust) → 0
		const unrealizedPnL =
			p.avgBuyPrice != null && p.solHolding > 0.0001
				? (this.lastTickerPrice - p.avgBuyPrice) * p.solHolding
				: 0;
		// 已实现盈亏: 分批回本/手动卖出累计
		const realizedPnL = p.realizedPnL || 0;
		// 总盈亏 = 浮盈 + 已实现
		const totalPnL = unrealizedPnL + realizedPnL;
		// 持仓回报率 (基于平均买入价)
		const positionPct =
			p.avgBuyPrice != null && p.avgBuyPrice > 0 && p.solHolding > 0.0001
				? ((this.lastTickerPrice - p.avgBuyPrice) / p.avgBuyPrice) * 100
				: 0;
		return {
			usdtBalance: p.usdtBalance,
			solHolding: p.solHolding,
			avgBuyPrice: p.avgBuyPrice,
			realizedPnL,
			unrealizedPnL,
			lastBuyPrice: p.lastBuyPrice,
			totalSpent: p.totalSpent,
			totalSoldUSDT: p.totalSoldUSDT || 0,
			consecutiveDcaBuys: p.consecutiveDcaBuys,
			currentMonthReset: p.currentMonthReset,
			monthSpentThisMonth: p.monthSpent.get(MONTH_KEY_FMT(new Date())) || 0,
			sellStairsTriggered: Array.from(p.sellStairsTriggered),
			currentValue: p.usdtBalance + p.solHolding * this.lastTickerPrice,
			// 总盈亏: 浮盈 + 已实现 (reset 后没持仓 → 0)
			profit: totalPnL,
			// 持仓百分比 (相对平均买入价, 没持仓 → 0)
			profitPct: positionPct
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
