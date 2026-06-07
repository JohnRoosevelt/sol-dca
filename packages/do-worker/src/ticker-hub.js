/**
 * TickerHub Durable Object
 *
 * 责任：
 * 1. 持有 1 个 OKX public WS（订阅 SOL-USDT ticker）
 * 2. 持有 N 个 browser WS（Hibernation API 持久化）
 * 3. ticker 推送 → 调 strategy.decide() → OKX private API 下单
 * 4. 写 trades / signals / portfolio_state 到 D1
 * 5. 监控：WS 断开 / ticker 30s 静默 / 下单失败 → 飞书 webhook
 * 6. 接收 browser 控制指令（pause / resume / manual）
 *
 * 通过 env.SOL_DCA_DB 访问 D1（wrangler 注入）
 * 通过 this.state 访问 DO 状态 + 持有 WS
 *
 * 路由（从 Worker fetch 转发）：
 *   GET  /ws              → upgrade WebSocket
 *   GET  /state           → 返回当前 portfolio + 最近 signals
 *   POST /control         → { action: 'pause'|'resume'|'manual_sell', ... }
 *   POST /init            → 强制从 D1 reload
 */

import { createOkxClient, checkOkxCredentials, OkxCredentialsMissingError } from './okx/client.js';
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
const MONTH_KEY_FMT = (d) => d.toISOString().slice(0, 7); // YYYY-MM

export class TickerHub {
	/**
	 * @param {DurableObjectState} state
	 * @param {Env} env
	 */
	constructor(state, env) {
		this.state = state;
		this.env = env;
		this.okx = createOkxClient(env);
		this.missingCredentials = checkOkxCredentials(env); // 空数组 = OK, 非空 = 缺凭证
		this.instId = env.OKX_INST_ID || 'SOL-USDT';
		this.channel = env.OKX_TICKER_CHANNEL || 'tickers';
		this.publicWsUrl = env.OKX_PUBLIC_WS || 'wss://ws.okx.com:8443/ws/v5/public';
		this.alertUrl = env.ALERT_WEBHOOK_URL || '';

		// 内存状态
		/** @type {any} */
		this.portfolio = null;
		this.isPaused = false;
		this.lastTickerAt = 0;
		this.lastTickerPrice = 0;
		this.lastOkxWsState = 'init';
		this.okxWs = null;
		this.reconnectTimer = null;
		this.heartbeatTimer = null;
		this.recentSignals = []; // 环形缓冲最近 50 条
	}

	/**
	 * 启动：读 D1 → 启 OKX WS → 启心跳
	 */
	async initialize() {
		await this.loadPortfolioFromD1();
		this.startHeartbeat();
		this.connectOkx();
	}

	/**
	 * 从 D1 读 portfolioState（首次 init 用）
	 */
	async loadPortfolioFromD1() {
		if (!this.env.SOL_DCA_DB) {
			console.warn('[TickerHub] D1 binding missing — using in-memory defaults');
			this.portfolio = this.defaultPortfolio();
			return;
		}
		try {
			const row = await this.env.SOL_DCA_DB.prepare('SELECT * FROM portfolio_state WHERE id = 1').first();
			if (row) {
				this.portfolio = this.rowToPortfolio(row);
				console.log('[TickerHub] loaded portfolio from D1:', JSON.stringify(this.portfolio));
			} else {
				// 第一次：建默认行
				this.portfolio = this.defaultPortfolio();
				await this.persistPortfolio();
				console.log('[TickerHub] created default portfolio row');
			}
		} catch (err) {
			console.error('[TickerHub] D1 load failed:', err);
			this.portfolio = this.defaultPortfolio();
		}
	}

	/**
	 * 默认 portfolio（V6 验证的初始 7000U）
	 */
	defaultPortfolio() {
		return {
			usdtBalance: STRATEGY_CONFIG.initialUSDT,
			solHolding: 0,
			lastBuyPrice: null,
			totalSpent: 0,
			consecutiveDcaBuys: 0,
			currentMonthReset: MONTH_KEY_FMT(new Date()),
			monthSpent: new Map(),
			sellStairsTriggered: new Set()
		};
	}

	rowToPortfolio(row) {
		return {
			usdtBalance: row.usdt_balance,
			solHolding: row.sol_holding,
			lastBuyPrice: row.last_buy_price,
			totalSpent: row.total_spent,
			consecutiveDcaBuys: row.consecutive_dca_buys || 0,
			currentMonthReset: row.current_month_reset || MONTH_KEY_FMT(new Date()),
			monthSpent: new Map(),
			sellStairsTriggered: new Set()
		};
	}

	portfolioToRow() {
		const p = this.portfolio;
		return {
			id: 1,
			usdt_balance: p.usdtBalance,
			sol_holding: p.solHolding,
			avg_buy_price: p.lastBuyPrice,
			last_buy_price: p.lastBuyPrice,
			last_buy_date: p.lastBuyPrice ? new Date().toISOString().slice(0, 10) : null,
			total_spent: p.totalSpent,
			total_sold: p.totalSoldUSDT || 0,
			current_month_spent: Array.from(p.monthSpent.values()).reduce((a, b) => a + b, 0),
			current_month_reset: p.currentMonthReset,
			consecutive_dca_buys: p.consecutiveDcaBuys,
			updated_at: new Date().toISOString()
		};
	}

	async persistPortfolio() {
		if (!this.env.SOL_DCA_DB) return;
		const row = this.portfolioToRow();
		await this.env.SOL_DCA_DB.prepare(
			`INSERT OR REPLACE INTO portfolio_state
			 (id, usdt_balance, sol_holding, avg_buy_price, last_buy_price, last_buy_date,
			  total_spent, total_sold, current_month_spent, current_month_reset,
			  consecutive_dca_buys, updated_at)
			 VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
		)
			.bind(
				row.id,
				row.usdt_balance,
				row.sol_holding,
				row.avg_buy_price,
				row.last_buy_price,
				row.last_buy_date,
				row.total_spent,
				row.total_sold,
				row.current_month_spent,
				row.current_month_reset,
				row.consecutive_dca_buys,
				row.updated_at
			)
			.run();
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
					// 自动重连
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

		// 3) 记录信号（无论 buy/sell/hold）
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
		this.recentSignals.unshift(signal);
		if (this.recentSignals.length > 50) this.recentSignals.length = 50;
		await this.persistSignal(signal);
		this.broadcastBrowser({ type: 'signal', ...signal });

		// 4) 执行 buy / sell
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
		const clOrdId = `sol-dca-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
		try {
			const res = await this.okx.marketBuy(this.instId, decision.amountUsdt, clOrdId);
			const ordId = res?.[0]?.ordId;
			const solBought = decision.amountUsdt / this.lastTickerPrice;
			applyBuy(this.portfolio, decision.amountUsdt, solBought, this.lastTickerPrice, MONTH_KEY_FMT(new Date()));
			await this.persistPortfolio();
			await this.persistTrade({
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
			});
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
		const clOrdId = `sol-dca-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
		try {
			const res = await this.okx.marketSell(this.instId, decision.amountSol, clOrdId);
			const ordId = res?.[0]?.ordId;
			applySell(this.portfolio, decision.amountUsdt, decision.amountSol, decision.stairIdx);
			await this.persistPortfolio();
			await this.persistTrade({
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
			});
			this.broadcastBrowser({ type: 'trade', side: 'sell', amountSol: decision.amountSol, price: this.lastTickerPrice, reason: decision.reason });
			this.sendAlertSafe('info', 'SELL executed', `${decision.reason} @ $${this.lastTickerPrice.toFixed(2)}`);
		} catch (err) {
			console.error('[TickerHub] sell failed:', err);
			this.sendAlertSafe('error', 'SELL failed', err.message);
			this.broadcastBrowser({ type: 'error', action: 'sell', message: err.message });
		}
	}

	async persistSignal(signal) {
		if (!this.env.SOL_DCA_DB) return;
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
	}

	async persistTrade(trade) {
		if (!this.env.SOL_DCA_DB) return;
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
	}

	/**
	 * 心跳：监控 ticker 静默 + 跨月重置
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
			// 立即发当前状态
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
				recentSignals: this.recentSignals.slice(0, 20),
				sabbath: isSabbath(),
				missingCredentials: this.missingCredentials,
				ts: Date.now()
			});
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
				// 显式建立 DCA 基准价：调 OKX 下首单 $30，设置 lastBuyPrice
				// 这是冷启动时的"点一下才开始"
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
				this.recentSignals.unshift(signal);
				if (this.recentSignals.length > 50) this.recentSignals.length = 50;
				await this.persistSignal(signal);
				this.broadcastBrowser({ type: 'signal', ...signal });
				await this.executeBuy(decision, signal);
				return Response.json({ ok: true });
			}
			if (action === 'manual_sell' && body.amountSol) {
				// 人工 sell：直接调 OKX
				if (this.missingCredentials.length > 0) {
					return Response.json(
						{ ok: false, error: 'OKX credentials missing' },
						{ status: 503 }
					);
				}
				const clOrdId = `sol-dca-manual-${Date.now()}`;
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
