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
	SAFEGUARD_CONFIG,
	decide,
	applyBuy,
	applySell,
	maybeResetMonth,
	computeBuyAmount
} from './strategy.js';
import { isSabbath } from './sabbath.js';
import { sendAlert } from './alert.js';

// 本地化时间戳日志 — 覆盖 console 方法，所有日志加北京时间标记
(() => {
	const ts = () => new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
	const origLog = console.log.bind(console);
	const origWarn = console.warn.bind(console);
	const origError = console.error.bind(console);
	console.log = (...a) => origLog(`[${ts()}]`, ...a);
	console.warn = (...a) => origWarn(`[${ts()}]`, ...a);
	console.error = (...a) => origError(`[${ts()}]`, ...a);
})();

const TICKER_TIMEOUT_MS = 30_000; // ticker 30s 没收到 = 静默
const WS_RECONNECT_MS = 5_000; // OKX WS 断开 5s 后重连
// (已删 BALANCE_SYNC_MS — balance sync 不再后台跑, 见 loadPortfolio 注释)
const MONTH_KEY_FMT = (d) => d.toISOString().slice(0, 7); // YYYY-MM

// 卖出时 SOL 数量精确到 4 位小数 (4 位以后截断, Math.floor)
//   原因: OKX 接受的下单 SOL sz 最多 4 位小数, 多于 4 位会被 OKX 隐式 round,
//     跟内部 state (6 位) 不一致可能触发 dust 状态机误判. 卖出路径统一 truncate.
function truncateSol4(amount) {
	return Math.floor(amount * 10000) / 10000;
}

// FIFO 上限: signals 50 条, trades 30 条
const SIGNAL_FIFO_LIMIT = 50;
const TRADE_FIFO_LIMIT = 30;

// Hold 信号 rate limit: OKX ticker 每秒推 ~10 次, 每个 tick 都记 hold 会刷屏
//   - 至少 HOLD_HEARTBEAT_MS (30s) 间隔 (心跳)
//   - 或价格相对上次记录的 hold 移动 > HOLD_PRICE_CHANGE_PCT (0.2%) — 立即补一条 (波动市)
//   - Buy/Sell/Skip 不限流, 立刻记
const HOLD_HEARTBEAT_MS = 30_000;
const HOLD_PRICE_CHANGE_PCT = 0.2;

// DO storage schema (DO 自带 permanent storage, 单一 source of truth)
//   PR6 (2026-06-08): 删 D1/Drizzle (drizzle/ 整目录 + src/db/schema.js + drizzle-orm dep + wrangler.toml D1 binding)
//   applyMigrations: DESTRUCTIVE WIPE + FRESH INIT — DROP 6 表 (idempotent IF EXISTS), 再用 SQL_SCHEMA 重建
//   - 老 DO 实例 (PR2 / PR5 状态) 部署后: 数据全清, schema 立刻对齐最新版
//   - 没有 _migrations tracking 表, 没有 ALTER TABLE, 没有 hasColumn 防御性读
//   - 重复 deploy 完全 idempotent (DROP IF EXISTS + CREATE IF NOT EXISTS)
//
// 设计原则:
//   - 简单 > 复杂: 一个权威 SQL_SCHEMA, 跟代码同步演进, 部署即对齐
//   - 老数据丢: user 2026-06-08 09:38 决策变更, 已知 + 接受 (前 PR2-PR5 没积累关键数据, demo/live 都是空的)
//   - 防御性读 / 写 列: 不需要, 部署后 schema 一定对齐
const SQL_SCHEMA = `
	CREATE TABLE IF NOT EXISTS portfolio_state (
		id INTEGER PRIMARY KEY,
		usdt_balance REAL NOT NULL DEFAULT 0,
		sol_holding REAL NOT NULL DEFAULT 0,
		avg_buy_price REAL,
		last_buy_price REAL,
		peak_price REAL,
		total_spent REAL NOT NULL DEFAULT 0,
		total_sold REAL NOT NULL DEFAULT 0,
		realized_pnl REAL NOT NULL DEFAULT 0,
		current_month_spent REAL NOT NULL DEFAULT 0,
		current_month_reset TEXT,
		consecutive_dca_buys INTEGER NOT NULL DEFAULT 0,
		sell_stairs_triggered TEXT NOT NULL DEFAULT '[]',
		-- PR5: 当前活跃 dca_round 的外键 (init_dca 写, close_round 清, 未启动时 null)
		current_round_id INTEGER,
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
	-- PR5: DCA 投资轮次 — 记录每轮生命周期 + P&L
	--   21 字段: roundUuid/startedAt/endedAt/startPrice/endPrice/initialUsdt/initialSol/finalUsdt/finalSol/
	--            totalSpent/totalSold/totalBuys/totalSells/realizedPnL/unrealizedPnL/totalReturnPct/
	--            status/closeReason/mode/notes/updatedAt
	CREATE TABLE IF NOT EXISTS dca_rounds (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		round_uuid TEXT NOT NULL UNIQUE,
		started_at TEXT NOT NULL,
		ended_at TEXT,
		start_price REAL NOT NULL,
		end_price REAL,
		initial_usdt REAL NOT NULL,
		initial_sol REAL NOT NULL DEFAULT 0,
		final_usdt REAL,
		final_sol REAL,
		total_spent REAL NOT NULL DEFAULT 0,
		total_sold REAL NOT NULL DEFAULT 0,
		total_buys INTEGER NOT NULL DEFAULT 0,
		total_sells INTEGER NOT NULL DEFAULT 0,
		realized_pnl REAL NOT NULL DEFAULT 0,
		unrealized_pnl REAL NOT NULL DEFAULT 0,
		total_return_pct REAL,
		status TEXT NOT NULL DEFAULT 'open',
		close_reason TEXT,
		mode TEXT NOT NULL DEFAULT 'demo',
		notes TEXT,
		updated_at TEXT NOT NULL
	);
	CREATE INDEX IF NOT EXISTS idx_signals_created_at ON signals (created_at DESC);
	CREATE INDEX IF NOT EXISTS idx_trades_created_at ON trades (created_at DESC);
	CREATE INDEX IF NOT EXISTS idx_dca_rounds_status ON dca_rounds (status);
	CREATE INDEX IF NOT EXISTS idx_dca_rounds_started_at ON dca_rounds (started_at DESC);
	CREATE TABLE IF NOT EXISTS alert_cooldowns (
		key TEXT PRIMARY KEY,
		last_sent INTEGER NOT NULL
	);
`;

/**
 * 每次部署都 DROP 旧表 + 用最新 SQL_SCHEMA 重建。
 * 数据会丢失，但 loadPortfolio 会从 OKX 重拉余额。
 * Single source of truth: SQL_SCHEMA constant. Schema evolves with code.
 *
 * @param {any} storage DO SQLite storage
 */
export function applyMigrations(storage) {
	const dropStatements = [
		'DROP TABLE IF EXISTS dca_rounds',
		'DROP TABLE IF EXISTS trades',
		'DROP TABLE IF EXISTS signals',
		'DROP TABLE IF EXISTS portfolio_state',
		'DROP TABLE IF EXISTS alert_cooldowns',
		// _migrations 表是 PR3 残留, 跟"no migration tracking"设计冲突.
		// 删掉确保 FORCE_SCHEMA_RESET 后彻底干净 (PR3-era _migrations 也 wipe)
		'DROP TABLE IF EXISTS _migrations'
	];

	// 总是 DROP 旧表 + 用最新 SQL_SCHEMA 重建，保证 schema 跟代码对齐
	// 数据会丢失（portfolio/trades/signals），但 DO 重启后 loadPortfolio 会从 OKX 重拉余额
	console.log('[TickerHub] applyMigrations: DROP all + recreate');
	for (const sql of dropStatements) {
		try {
			storage.sql.exec(sql);
		} catch (err) {
			console.warn('[TickerHub] DROP failed (continuing):', sql, err.message);
		}
	}

	try {
		storage.sql.exec(SQL_SCHEMA);
	} catch (err) {
		console.error('[TickerHub] SQL_SCHEMA failed:', err);
		throw err;
	}

	console.log('[TickerHub] applyMigrations: complete');
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
		// 每次部署 DROP + 重建 schema（数据从 OKX 重拉）
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
		// PR-Alarm (2026-06-08): Alarm 叫醒时如果 isTrading=true (上一个 decide 还没跑完), 跳过
		this._alarmTickRunning = false;
		// ticker 限流：策略决策每 3s 最多一次，省 DO 免费层请求配额
		this._lastStrategyTickAt = 0;

		// 内存状态 (不持久化 / 不需要 FIFO 限的)
		/** @type {any} */
		this.portfolio = null;
		this.isPaused = false;
		// PR5: 硬启动开关 (策略层) — 跟 OKX WS 推送 (传输层) 完全独立
		this.isStarted = false;
		// PR5: 4 个护栏的运行时状态
		this.consecutiveFailures = 0; // circuit_breaker 计数
		this.peakValue = 0; // max_loss 护栏: 总值 peak (usdtBalance + solHolding × price)
		this.currentRoundId = null; // dca_rounds.id 当前活跃 round
		this.lastTickerAt = 0;
		this.lastTickerPrice = 0;
		this.lastOkxWsState = 'init';
		this.okxWs = null;
		this.reconnectTimer = null;
		this.heartbeatTimer = null;
		this.recentHoldSignals = []; // 内存 hold 环形缓冲 (前端 fold count 用, 不写 storage)
		this.lastHoldSignalAt = 0; // rate limit: 上次 emit hold 的 timestamp
		this.lastHoldSignalPrice = 0; // rate limit: 上次 emit hold 时的价格 (算价格变化用)
		// P0-1 in-flight lock: OKX WS 推送 ~3.2Hz (≈310ms 间隔), 但 executeBuy/executeSell
		//   await OKX API 100-500ms. 上一笔 buy/sell 还没结算时, 第二个 ticker 进来读
		//   到旧 lastBuyPrice 会触发 duplicate buy (silent 2x). isTrading 守门期间跳过
		//   decide + execute, 防止并发下单. Ticker WS 广播不走这把锁, 价格照常推.
		this.isTrading = false;

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
	 * 启动：读 portfolio → 启 OKX WS → 启心跳 → 设 Alarm
	 */
	async initialize() {
		await this.loadPortfolio();
		this.startHeartbeat();
		this.connectOkx();
		// PR-Alarm gate (2026-06-08, refined 2026-06-09): 24/7 alarm 只在 live + 持仓中跑
		//   背景: 6/8 引入 PR-Alarm 让 demo 24/7 烧光 DO free tier 100K req/day
		//   真正的 quota 雪崩根因是前端 WS reconnect 没 backoff (见 TickerStream.svelte),
		//   alarm 不是主因, 但 demo 24/7 alarm 仍在烧, 保留作为防御
		if (this.shouldRunAlarm()) {
			await this.setAlarm();
		} else {
			await this.clearAlarm();
			console.log(`[TickerHub] initialize: alarm gated off (mode=${this.mode}, isStarted=${this.isStarted})`);
		}
	}

	/**
	 * Cloudflare DO alarm handler — Alarm 触发时由 runtime 直接调用
	 * (fetch 中 x-durable-od-alarm header 检测是 miniflare 兼容路径)
	 */
	async alarm() {
		await this.alarmTick();
	}

	/**
	 * 设下次 Alarm (60s 后叫醒)
	 * alarmFired 后 DO 重启, initialize() 会重新设 alarm — 但这里也设一次作双重保险
	 */
	async setAlarm() {
		await this.state.storage.setAlarm(Date.now() + 60_000);
	}

	/**
	 * PR-Alarm gate (2026-06-09): 24/7 alarm 只在 live + 持仓中跑
	 *   - demo 永远不跑 (烧光 DO free tier 100K req/day, user 2026-06-09 决策)
	 *   - live + !isStarted 也不跑 (没持仓, 跟 demo 一样省 quota)
	 *   - live + isStarted 才跑 (护栏必须跑, 持仓是真钱)
	 */
	shouldRunAlarm() {
		return this.isStarted;
	}

	/**
	 * 清除 alarm (gate 不通过时调 — 不让 alarm 继续 60s 一次叫醒)
	 */
	async clearAlarm() {
		await this.state.storage.deleteAlarm();
	}

	/**
	 * PR-Alarm (2026-06-08): Alarm 触发时执行的监控周期
	 *   1. 重新连 OKX WS (页面没开时 DO 休眠, OKX WS 已断)
	 *   2. 等一条 ticker (拿最新价格)
	 *   3. 如果 isStarted=true → 跑一次完整 decide 决策 (护栏检查 + decide + 执行)
	 *   4. 设下次 alarm
	 *
	 * 防御:
	 *   - _alarmTickRunning: 防止 alarm 重叠 (alarm 间隔 60s > executeBuy 典型时长 ~1s, 保守加锁)
	 *   - isTrading: 同 decide() 里的 in-flight lock, 防止并发 decide
	 *   - 不在这里发 browser 广播 (没人开页面), 只写 storage + 发飞书 alert
	 */
	async alarmTick() {
		// PR-Alarm gate (2026-06-09): 老 DOs 可能带旧 alarm, 启动时 isStarted=true 但后续
		//   被 closeDcaRound/reset 改成 false. top check 保证 gate 不通过时彻底清掉
		//   (deleteAlarm), 不再 60s 一次叫醒空跑 (demo / !isStarted 都不该烧 quota)
		if (!this.shouldRunAlarm()) {
			await this.clearAlarm();
			console.log(`[TickerHub] alarmTick: gate off, alarm cleared (mode=${this.mode}, isStarted=${this.isStarted})`);
			return;
		}
		if (this._alarmTickRunning) {
			console.log('[TickerHub] alarmTick skipped: previous still running');
			await this.setAlarm();
			return;
		}
		this._alarmTickRunning = true;
		try {
			// 0) 恢复持久化状态 (DO 回收后 alarm 唤醒时 isStarted/currentRoundId 丢失)
			if (!this.portfolio) {
				await this.loadPortfolio();
			}
			// 1) reconnect OKX WS (页面没开时已断)
			this.connectOkx();

			// 2) 等一条 ticker (最多 5s timeout — alarm 每 60s 一次, 5s wait 够用)
			const tickerTimeout = 5_000;
			const deadline = Date.now() + tickerTimeout;
			await new Promise((resolve) => {
				const check = () => {
					if (Date.now() >= deadline) { resolve(); return; }
					if (this.lastTickerPrice > 0 && this.lastTickerAt > 0) { resolve(); return; }
					setTimeout(check, 200);
				};
				check();
			});

			if (!this.isStarted || !this.portfolio || this.lastTickerPrice <= 0) {
				console.log('[TickerHub] alarmTick: not started or no ticker, skip decide');
				await this.setAlarm();
				return;
			}

			// 3) 同 decide() 里的 isTrading in-flight lock
			if (this.isTrading) {
				console.log('[TickerHub] alarmTick skipped: isTrading=true (previous buy/sell still in flight)');
				await this.setAlarm();
				return;
			}
			this.isTrading = true;

			try {
				// 安息日检查
				if (isSabbath()) {
					console.log('[TickerHub] alarmTick: sabbath, skip decide');
					await this.setAlarm();
					return;
				}

				// max_loss 护栏检查 (同 handleTicker)
				const currentValue = this.portfolio.usdtBalance + this.portfolio.solHolding * this.lastTickerPrice;
				if (this.peakValue > 0 && currentValue <= this.peakValue * (1 + SAFEGUARD_CONFIG.maxLossPct)) {
					const drawdownPct = (this.peakValue - currentValue) / this.peakValue;
					console.log(
						`[TickerHub] alarmTick sg_max_loss: drawdown=${(drawdownPct * 100).toFixed(2)}% ≤ ${(SAFEGUARD_CONFIG.maxLossPct * 100).toFixed(0)}%, isStarted=false`
					);
					this.isStarted = false;
					await this.persistPortfolio();
					this.sendAlertSafe(
						'critical',
						'MAX_LOSS triggered (alarm)',
						`峰值回撤 ${(drawdownPct * 100).toFixed(2)}% ≤ ${(SAFEGUARD_CONFIG.maxLossPct * 100).toFixed(0)}%, 已暂停策略 (持仓保留)`
					);
					await this.setAlarm();
					return;
				}

				// 跑 decide
				const todayMonthKey = MONTH_KEY_FMT(new Date());
				maybeResetMonth(this.portfolio, todayMonthKey);
				const tickerSnapshot = {
					last: this.lastTickerPrice,
					open24h: this.lastTickerPrice, // alarm tick 用 last 价作 open24h 近似
					ts: Math.floor(Date.now() / 1000)
				};
				const decision = decide(tickerSnapshot, this.portfolio, todayMonthKey);

				if (decision.action === 'buy' && decision.amountUsdt >= 1) {
					const signal = {
						id: crypto.randomUUID(),
						price: this.lastTickerPrice,
						action: 'buy',
						reason: `[alarm] ${decision.reason}`,
						drawdown_pct: decision.drawdownPct ?? null,
						profit_pct: null,
						usdt_after: this.portfolio.usdtBalance,
						sol_after: this.portfolio.solHolding,
						mode: this.mode,
						created_at: new Date().toISOString()
					};
					await this.persistSignal(signal);
					this.sendAlertSafe(
						'info',
						'BUY executed (alarm)',
						`[alarm] ${decision.reason} @ $${this.lastTickerPrice.toFixed(2)} — $${decision.amountUsdt}`
					);
					await this.executeBuy(decision, signal);
				} else if (decision.action === 'sell' && decision.amountSol >= 0.001) {
					const signal = {
						id: crypto.randomUUID(),
						price: this.lastTickerPrice,
						action: 'sell',
						reason: `[alarm] ${decision.reason}`,
						drawdown_pct: null,
						profit_pct: decision.profitPct ?? null,
						usdt_after: this.portfolio.usdtBalance,
						sol_after: this.portfolio.solHolding,
						mode: this.mode,
						created_at: new Date().toISOString()
					};
					await this.persistSignal(signal);
					this.sendAlertSafe(
						'info',
						'SELL executed (alarm)',
						`[alarm] ${decision.reason} @ $${this.lastTickerPrice.toFixed(2)} — ${decision.amountSol} SOL`
					);
					await this.executeSell(decision, signal);
				} else {
					// hold / skip — 不触发任何交易, 只 log
					if (Date.now() % (5 * 60_000) < 1_000) { // 大约每 5 分钟 log 一次 (避免刷屏)
						console.log(`[TickerHub] alarmTick hold: ${decision.reason}`);
					}
				}
			} finally {
				this.isTrading = false;
			}
		} catch (err) {
			console.error('[TickerHub] alarmTick error:', err);
		} finally {
			this._alarmTickRunning = false;
			await this.setAlarm();
		}
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
			// PR5: 从存储恢复 isStarted/currentRoundId (DO 重启不能丢活跃 round)
			if (this.portfolio.currentRoundId != null) {
				this.currentRoundId = this.portfolio.currentRoundId;
				this.isStarted = true;
			}
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
			peakPrice: null, // P0-2: 跟 lastBuyPrice 同步, 首次 buy 时由 applyBuy 设为买价
			totalSpent: 0,
			totalSoldUSDT: 0,
			consecutiveDcaBuys: 0,
			currentMonthReset: MONTH_KEY_FMT(new Date()),
			monthSpent: new Map(),
			sellStairsTriggered: new Set(),
			currentRoundId: null // PR5: 跟 isStarted 同步, init_dca 写, close_round 清
		};
	}

	/**
	 * 把 DO storage row (snake_case) 映射到 portfolio 对象
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
			peakPrice: row.peak_price != null ? row.peak_price : null, // P0-2: 高位建仓后熊市初期不漏 DCA
			totalSpent: row.total_spent,
			totalSoldUSDT: row.total_sold || 0,
			consecutiveDcaBuys: row.consecutive_dca_buys || 0,
			currentMonthReset: row.current_month_reset || MONTH_KEY_FMT(new Date()),
			monthSpent,
			sellStairsTriggered: new Set(
				JSON.parse(row.sell_stairs_triggered || '[]')
			),
			currentRoundId: row.current_round_id != null ? row.current_round_id : null // PR5: dca_rounds 外键
		};
	}

	/**
	 * 持久化 portfolio — DO storage
	 */
	async persistPortfolio() {
		if (!this.portfolio) return;
		const p = this.portfolio;
		// demo 跟 live 各自用独立 row id (1 / 2)
		const portfolioRowId = this.mode === 'live' ? 2 : 1;
		// monthSpentTotal 只算 currentMonthReset 月份 (跨月重置时其他月份不存, 避免数据膨胀)
		const monthSpentTotal = p.monthSpent.get(p.currentMonthReset) || 0;
		const sellStairsJson = JSON.stringify(Array.from(p.sellStairsTriggered).sort());
		const updatedAt = new Date().toISOString();

		// 1) DO storage (主)
		try {
			this.state.storage.sql.exec(
				`INSERT OR REPLACE INTO portfolio_state
				 (id, usdt_balance, sol_holding, avg_buy_price, last_buy_price, peak_price, total_spent, total_sold,
				  realized_pnl, current_month_spent, current_month_reset, consecutive_dca_buys,
				  sell_stairs_triggered, current_round_id, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				portfolioRowId,
				p.usdtBalance,
				p.solHolding,
				p.avgBuyPrice,
				p.lastBuyPrice,
				p.peakPrice, // P0-2
				p.totalSpent,
				p.totalSoldUSDT || 0,
				p.realizedPnL || 0,
				monthSpentTotal,
				p.currentMonthReset,
				p.consecutiveDcaBuys,
				sellStairsJson,
				p.currentRoundId ?? null, // PR5: dca_rounds 外键
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
		//   PR5: 即使 isStarted=false (硬启动开关 off), 价格仍照常广播 — 传输层不断, 策略层开关
		this.broadcastBrowser({
			type: 'ticker',
			price: this.lastTickerPrice,
			open24h: parseFloat(d.open24h),
			high24h: parseFloat(d.high24h),
			low24h: parseFloat(d.low24h),
			ts: parseInt(d.ts)
		});

		// P0-2: 持续跟踪 peakPrice (建仓以来最高价) — 不只 buy 时更新, 每个 ticker 都 max
		//   已建仓后 (lastBuyPrice != null) 才有意义, 否则冷启动阶段 peakPrice=null 跳过
		//   这里更新不持久化, 由 decide() / executeBuy / syncBalanceFromOkx 触发的 persistPortfolio 顺带写盘
		if (this.portfolio && this.portfolio.lastBuyPrice != null) {
			const newPeak = Math.max(this.portfolio.peakPrice ?? 0, this.lastTickerPrice);
			if (newPeak !== this.portfolio.peakPrice) {
				this.portfolio.peakPrice = newPeak;
			}
		}

		// PR5 (sg_max_loss): 持续跟踪 peakValue (总值峰值) — 用于 max_loss 护栏
		//   触发: (currentValue - peakValue) / peakValue <= -0.30 → isStarted=false + sendAlert
		//   currentValue = usdtBalance + solHolding × ticker.last
		//   跟踪放在 paused/sabbath/portfolio 守卫之前 — max_loss 护栏要能独立检测, 不被这些守卫短路
		if (this.portfolio && this.isStarted) {
			const currentValue = this.portfolio.usdtBalance + this.portfolio.solHolding * this.lastTickerPrice;
			const newPeak = Math.max(this.peakValue, currentValue);
			if (newPeak !== this.peakValue) {
				this.peakValue = newPeak;
			}
			// 检查 max_loss 护栏
			if (this.peakValue > 0) {
				const drawdownPct = (currentValue - this.peakValue) / this.peakValue;
				if (drawdownPct <= SAFEGUARD_CONFIG.maxLossPct) {
					console.log(
						`[TickerHub] sg_max_loss triggered: drawdown=${(drawdownPct * 100).toFixed(2)}% ≤ ${(SAFEGUARD_CONFIG.maxLossPct * 100).toFixed(0)}%, isStarted=false`
					);
					this.isStarted = false;
					this.sendAlertSafe(
						'critical',
						'MAX_LOSS triggered',
						`峰值回撤 ${(drawdownPct * 100).toFixed(2)}% ≤ ${(SAFEGUARD_CONFIG.maxLossPct * 100).toFixed(0)}%, 已暂停策略 (持仓保留)`
					);
					this.broadcastBrowser({
						type: 'max_loss_triggered',
						drawdownPct: drawdownPct * 100,
						peakValue: this.peakValue,
						currentValue,
						isStarted: false
					});
					return;
				}
			}
		}

		// 限流：OKX ticker ~10次/秒，策略决策不需要这么高频
		// 每 3/5 秒跑一次 decide() 足够（价格 3/5s 内变化不会触发多级加码跳变）
		// 省 DO 免费层请求配额：~86万次/天 → ~2.8万次/天
		const now = Date.now();
		if (this._lastStrategyTickAt && now - this._lastStrategyTickAt < 5000) return;
		this._lastStrategyTickAt = now;

		// 2) 调策略
		if (this.isPaused) return;
		if (isSabbath()) return;
		if (!this.portfolio) return;

		// PR5: 硬启动开关 — !isStarted 时跳过 decide() (策略层 off), 但 ticker 仍广播 (传输层 on)
		//   区别于 isPaused: isPaused 是短期暂停 (state 不动), isStarted 是长期开关 (跟 dca_rounds 同步)
		if (!this.isStarted) return;

		// P0-1 in-flight lock: 上一次 buy/sell 还在 await OKX API 时, 后续 ticker 跳过 decide+execute
		//   锁放在此处 (paused/sabbath/portfolio/isStarted 守卫之后) — 这些守卫仍走早 return,
		//   不污染 isTrading 状态. WS ticker 广播 (上方) 永远不走这把锁, 价格照常推.
		if (this.isTrading) return;
		this.isTrading = true;
		try {
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
					// 限流: 不 emit — finally 会把 isTrading 清回 false
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
		} finally {
			// P0-1: 不管 buy/sell 成功/失败, isTrading 都必须释放, 否则后续 ticker 永远被卡住
			this.isTrading = false;
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
			// PR5 (sg_circuit_breaker): 成功执行 → 重置 consecutiveFailures
			this.consecutiveFailures = 0;
			// 下单成功后立即拉 OKX 真实余额, dashboard 跟账户实时对准
			await this.syncBalanceFromOkx();
		} catch (err) {
			console.error('[TickerHub] buy failed:', err);
			// PR5 (sg_circuit_breaker): 累加 consecutiveFailures, 触到阈值 → isPaused=true
			this.consecutiveFailures++;
			if (this.consecutiveFailures >= SAFEGUARD_CONFIG.circuitBreakerFails) {
				this.isPaused = true;
				this.sendAlertSafe(
					'critical',
					'CIRCUIT BREAKER triggered',
					`连续 ${this.consecutiveFailures} 次 buy/sell 失败 (阈值 ${SAFEGUARD_CONFIG.circuitBreakerFails}), 策略已暂停 — 需手动调 /control resume 恢复`
				);
				this.broadcastBrowser({
					type: 'circuit_breaker_triggered',
					consecutiveFailures: this.consecutiveFailures,
					threshold: SAFEGUARD_CONFIG.circuitBreakerFails,
					isPaused: true
				});
			}
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
			const res = await this.okx.marketSell(this.instId, truncateSol4(decision.amountSol), clOrdId);
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

			applySell(this.portfolio, usdtGot, solSold, realAvgPx, decision.stairIdx);
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
			// PR5 (sg_circuit_breaker): 成功执行 → 重置 consecutiveFailures
			this.consecutiveFailures = 0;
			// 卖单成功后立即拉 OKX 真实余额, dashboard 跟账户实时对准
			await this.syncBalanceFromOkx();
		} catch (err) {
			console.error('[TickerHub] sell failed:', err);
			// PR5 (sg_circuit_breaker): 累加 consecutiveFailures, 触到阈值 → isPaused=true
			this.consecutiveFailures++;
			if (this.consecutiveFailures >= SAFEGUARD_CONFIG.circuitBreakerFails) {
				this.isPaused = true;
				this.sendAlertSafe(
					'critical',
					'CIRCUIT BREAKER triggered',
					`连续 ${this.consecutiveFailures} 次 buy/sell 失败 (阈值 ${SAFEGUARD_CONFIG.circuitBreakerFails}), 策略已暂停 — 需手动调 /control resume 恢复`
				);
				this.broadcastBrowser({
					type: 'circuit_breaker_triggered',
					consecutiveFailures: this.consecutiveFailures,
					threshold: SAFEGUARD_CONFIG.circuitBreakerFails,
					isPaused: true
				});
			}
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
	 * PR5: 打开一个新 DCA round (init_dca handler 调)
	 *   写 dca_rounds row + 返回 roundId
	 *   status='open', started_at=now, end_* 全 NULL (round 未结束)
	 *
	 * @param {{startPrice: number, initialUsdt: number, initialSol: number, closeReason?: string|null, notes?: string}} args
	 * @returns {Promise<number>} roundId (AUTOINCREMENT pk)
	 */
	async openDcaRound({ startPrice, initialUsdt, initialSol, closeReason = null, notes = null }) {
		const roundUuid = crypto.randomUUID();
		const now = new Date().toISOString();
		try {
			// 1) insert new round row
			this.state.storage.sql.exec(
				`INSERT INTO dca_rounds
				 (round_uuid, started_at, ended_at, start_price, end_price,
				  initial_usdt, initial_sol, final_usdt, final_sol,
				  total_spent, total_sold, total_buys, total_sells,
				  realized_pnl, unrealized_pnl, total_return_pct,
				  status, close_reason, mode, notes, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				roundUuid,
				now,
				null, // ended_at NULL = open
				startPrice,
				null, // end_price NULL
				initialUsdt,
				initialSol,
				null, // final_usdt NULL until close
				null, // final_sol NULL
				0, // total_spent
				0, // total_sold
				0, // total_buys
				0, // total_sells
				0, // realized_pnl
				0, // unrealized_pnl
				null, // total_return_pct
				'open',
				closeReason,
				this.mode,
				notes,
				now
			);
			const result = this.state.storage.sql.exec('SELECT last_insert_rowid() AS id').one();
			const roundId = result?.id;
			console.log(`[TickerHub] openDcaRound: roundId=${roundId} uuid=${roundUuid} startPrice=$${startPrice}`);
			return roundId;
		} catch (err) {
			console.error('[TickerHub] openDcaRound failed:', err);
			throw err;
		}
	}

	/**
	 * PR5: 关闭一个 DCA round (close_round handler / sweep_close 自动触发调)
	 *   写 endedAt + endPrice + finalUsdt/Sol + totalReturnPct
	 *   重置 portfolio 策略字段 (lastBuyPrice=null, avgBuyPrice=null, sellStairsTriggered=Set, currentRoundId=null)
	 *   持仓 solHolding/usdtBalance 保留 (跟 user 决策一致: sell 已关, sweep_close 不需要清仓)
	 *   isStarted=false, peakValue=0
	 *
	 * @param {number} roundId
	 * @param {{closeReason?: string}} [opts]
	 * @returns {Promise<{roundId: number, endPrice: number, finalUsdt: number, finalSol: number, totalReturnPct: number, closeReason: string}>}
	 */
	async closeDcaRound(roundId, opts = {}) {
		const closeReason = opts.closeReason ?? 'manual_close';
		const now = new Date().toISOString();
		const endPrice = this.lastTickerPrice;
		const finalUsdt = this.portfolio.usdtBalance;
		const finalSol = this.portfolio.solHolding;
		// totalReturnPct = (finalValue - initialUsdt) / initialUsdt × 100
		//   initialUsdt 从 dca_rounds 表读 (initial_usdt 列), 这次查询
		const roundRow = this.state.storage.sql
			.exec('SELECT * FROM dca_rounds WHERE id = ?', roundId)
			.toArray()[0];
		const initialUsdt = roundRow?.initial_usdt ?? finalUsdt;
		const finalValue = finalUsdt + finalSol * endPrice;
		const totalReturnPct = initialUsdt > 0
			? ((finalValue - initialUsdt) / initialUsdt) * 100
			: 0;
		try {
			this.state.storage.sql.exec(
				`UPDATE dca_rounds SET
				 ended_at = ?, end_price = ?, final_usdt = ?, final_sol = ?,
				 total_return_pct = ?, status = 'closed', close_reason = ?, updated_at = ?
				 WHERE id = ?`,
				now,
				endPrice,
				finalUsdt,
				finalSol,
				totalReturnPct,
				closeReason,
				now,
				roundId
			);
		} catch (err) {
			console.error('[TickerHub] closeDcaRound UPDATE failed:', err);
			throw err;
		}
		// 重置 portfolio 策略字段 (保留 holdings)
		this.portfolio.lastBuyPrice = null;
		this.portfolio.avgBuyPrice = null;
		this.portfolio.peakPrice = null;
		this.portfolio.sellStairsTriggered = new Set();
		this.portfolio.consecutiveDcaBuys = 0;
		this.portfolio.currentRoundId = null;
		// 重置护栏峰值
		this.peakValue = 0;
		this.isStarted = false;
		await this.persistPortfolio();
		console.log(
			`[TickerHub] closeDcaRound: roundId=${roundId} endPrice=$${endPrice.toFixed(2)} ` +
			`returnPct=${totalReturnPct.toFixed(2)}% reason=${closeReason}`
		);
		this.sendAlertSafe(
			'info',
			'DCA round closed',
			`round_id=${roundId} end=$${endPrice.toFixed(2)} return=${totalReturnPct.toFixed(2)}% reason=${closeReason}`
		);
		return {
			roundId,
			endPrice,
			finalUsdt,
			finalSol,
			totalReturnPct,
			closeReason
		};
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

		// PR-Alarm (2026-06-08): Cloudflare Alarm 叫醒 DO — 不带 HTTP 请求体
		//   Alarm 每 60s 触发一次, 让 DO 在没人开页面的情况下仍维持 OKX WS + 策略监控
		if (request.headers.get('x-durable-od-alarm') === 'true') {
			await this.alarmTick();
			return new Response(null, { status: 204 });
		}

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
						isStarted: this.isStarted, // PR5: 硬启动开关状态
						currentRoundId: this.currentRoundId, // PR5: 当前活跃 round
						consecutiveFailures: this.consecutiveFailures, // PR5: circuit_breaker 计数
						peakValue: this.peakValue, // PR5: max_loss 护栏峰值
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
				isStarted: this.isStarted, // PR5: 硬启动开关
				currentRoundId: this.currentRoundId, // PR5: 当前活跃 round
				consecutiveFailures: this.consecutiveFailures, // PR5: circuit_breaker 计数
				peakValue: this.peakValue, // PR5: max_loss 护栏峰值
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
					isStarted: this.isStarted, // PR5
					currentRoundId: this.currentRoundId, // PR5
					consecutiveFailures: this.consecutiveFailures, // PR5
					peakValue: this.peakValue, // PR5
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
							await this.okx.marketSell(this.instId, truncateSol4(solBalance), clOrdId);
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
				// PR5: 重置时清掉当前活跃 round (close_round 路径) — reset 视作 user_reset
				if (this.currentRoundId != null) {
					try {
						await this.closeDcaRound(this.currentRoundId, { closeReason: 'user_reset' });
					} catch (err) {
						console.warn('[TickerHub] reset closeDcaRound failed:', err.message);
					}
				}
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
					peakPrice: null, // P0-2: 跟 lastBuyPrice 同步 reset, 下次 DCA 启动时由 applyBuy 重建
					totalSpent: 0,
					totalSoldUSDT: 0,
					realizedPnL: 0,
					consecutiveDcaBuys: 0,
					sellStairsTriggered: new Set(),
					monthSpent: new Map(),
					currentMonthReset: MONTH_KEY_FMT(new Date()),
					currentRoundId: null // PR5: 跟 isStarted 同步, reset 后无活跃 round
				};
			}
				await this.persistPortfolio();
				// PR5: reset 也清护栏运行时状态
				this.consecutiveFailures = 0;
				this.peakValue = 0;
				this.isStarted = false;
				this.currentRoundId = null;
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
				// PR5: init_dca 只创建 round + 设 isStarted=true — 不再自动买入
				//   首买由 manual_buy handler 显式触发 (策略层强制要求 user 主动决策)
				const roundId = await this.openDcaRound({
					startPrice: this.lastTickerPrice,
					initialUsdt: this.portfolio.usdtBalance,
					initialSol: this.portfolio.solHolding,
					closeReason: null,
					notes: body?.notes ?? 'init_dca (manual first buy)'
				});
				this.currentRoundId = roundId;
				this.portfolio.currentRoundId = roundId;
				this.isStarted = true;
				this.peakValue = this.portfolio.usdtBalance + this.portfolio.solHolding * this.lastTickerPrice;
				await this.persistPortfolio();
				this.broadcastBrowser({
					type: 'dca_initialized',
					roundId,
					isStarted: true,
					lastTickerPrice: this.lastTickerPrice
				});
				this.sendAlertSafe(
					'info',
					'DCA started',
					`round_id=${roundId} start_price=$${this.lastTickerPrice.toFixed(2)} (manual first buy via /control manual_buy)`
				);
				return Response.json({ ok: true, roundId, isStarted: true });
			}
			if (action === 'manual_buy') {
				if (this.missingCredentials.length > 0) {
					return Response.json(
						{ ok: false, error: 'OKX credentials missing' },
						{ status: 503 }
					);
				}
				if (!this.isStarted || this.currentRoundId == null) {
					return Response.json(
						{ ok: false, error: 'DCA not started — call /control init_dca first' },
						{ status: 409 }
					);
				}
				// PR5: manual_buy 走动态供应率 — baseAmount = balance × supplyRates.base
				//   跟 decide() 自动 DCA 同样的金额公式, 保证 user 主动 / 被动决策的一致性
				const { baseAmount } = computeBuyAmount(this.portfolio);
				let buyAmount = Number.isFinite(body.amountUsdt) && body.amountUsdt > 0
					? body.amountUsdt
					: baseAmount;
				const clamped = baseAmount; // manual 也走自适应基准, body.amountUsdt 兜底
				if (body.amountUsdt && Number.isFinite(body.amountUsdt) && body.amountUsdt > 0) {
					// 显式指定金额时, clamp 到 [minBuyAbsolute, balance × maxBuyPct, balance]
					const minBuy = STRATEGY_CONFIG.minBuyAbsolute;
					const maxBuy = this.portfolio.usdtBalance * STRATEGY_CONFIG.maxBuyPct;
					if (buyAmount < minBuy) buyAmount = minBuy;
					if (buyAmount > maxBuy) buyAmount = maxBuy;
					if (buyAmount > this.portfolio.usdtBalance) buyAmount = this.portfolio.usdtBalance;
				} else {
					buyAmount = clamped;
				}
				if (buyAmount < STRATEGY_CONFIG.minBuyAbsolute) {
					return Response.json(
						{ ok: false, error: `buyAmount $${buyAmount.toFixed(2)} < minBuyAbsolute $${STRATEGY_CONFIG.minBuyAbsolute}` },
						{ status: 400 }
					);
				}
				if (buyAmount > this.portfolio.usdtBalance) {
					return Response.json(
						{ ok: false, error: `buyAmount $${buyAmount.toFixed(2)} > balance $${this.portfolio.usdtBalance.toFixed(2)}` },
						{ status: 400 }
					);
				}
				const decision = {
					action: 'buy',
					amountUsdt: buyAmount,
					reason: `manual_buy: $${buyAmount.toFixed(0)} (round ${this.currentRoundId})`,
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
				return Response.json({ ok: true, amountUsdt: buyAmount, roundId: this.currentRoundId });
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
					const solSold = truncateSol4(body.amountSol);
					await this.okx.marketSell(this.instId, solSold, clOrdId);
					const sellUsdt = solSold * this.lastTickerPrice;
					// PR4 (2026-06-08): 走 applySell 而非直接改 state — 让 realizedPnL/totalSoldUSDT/
					//   consecutiveDcaBuys/avgBuyPrice 等字段跟阶梯 sell 走同一路径, sweep_close
					//   判定 (卖光 < 0.0001 → 清 avgBuyPrice) 自动复用. stairIdx=-1 是 manual 标识,
					//   applySell 跳过 sellStairsTriggered.add, 避免污染阶梯状态.
					applySell(this.portfolio, sellUsdt, solSold, this.lastTickerPrice, -1);
					await this.persistPortfolio();
					this.broadcastBrowser({ type: 'manual_sell_done', amountSol: solSold });
					// PR5 (sg_sweep_close): manual_sell 后 solHolding < dust → 自动 close round
					//   保留 solHolding/usdtBalance (manual_sell 已经清掉了 SOL), 只重置 DCA 策略状态
					if (this.portfolio.solHolding < SAFEGUARD_CONFIG.sweepCloseDust && this.currentRoundId != null) {
						await this.closeDcaRound(this.currentRoundId, { closeReason: 'manual_sell_all' });
					}
					// 卖成功后立即拉 OKX 真实余额, dashboard 跟账户实时对准
					await this.syncBalanceFromOkx();
					return Response.json({ ok: true });
				} catch (err) {
					return Response.json({ ok: false, error: String(err) }, { status: 500 });
				}
			}
			// PR5: close_round handler — sweep sell + close round + reset state + isStarted=false
			if (action === 'close_round') {
				if (this.currentRoundId == null) {
					return Response.json(
						{ ok: false, error: 'No active DCA round to close' },
						{ status: 404 }
					);
				}
				let swept = 0;
				let sweepUsdt = 0;
				let sweepErr = null;
				// 1) sweep sell all remaining SOL (if any) via applySell(-1)
				if (this.portfolio.solHolding > SAFEGUARD_CONFIG.sweepCloseDust && this.missingCredentials.length === 0) {
					try {
						const clOrdId = `solDcaX${this.mode === 'live' ? 'L' : 'D'}${Date.now()}${crypto.randomUUID().replace(/-/g, '').slice(0, 6)}`;
						await this.okx.marketSell(this.instId, truncateSol4(this.portfolio.solHolding), clOrdId);
						swept = this.portfolio.solHolding;
						sweepUsdt = swept * this.lastTickerPrice;
						applySell(this.portfolio, sweepUsdt, swept, this.lastTickerPrice, -1);
						await this.persistPortfolio();
					} catch (err) {
						sweepErr = `sweep sell failed: ${err.message}`;
						console.warn('[TickerHub] close_round sweep failed:', err.message);
					}
				}
				// 2) close the round + reset state
				const closed = await this.closeDcaRound(this.currentRoundId, {
					closeReason: body?.reason ?? 'manual_close'
				});
				this.broadcastBrowser({
					type: 'round_closed',
					roundId: this.currentRoundId,
					closed,
					swept,
					sweepUsdt,
					sweepErr
				});
				return Response.json({
					ok: true,
					closed,
					swept,
					sweepUsdt,
					sweepErr
				});
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
			peakPrice: p.peakPrice, // P0-2: 前端可见的"建仓以来最高价"参考
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
			profitPct: positionPct,
			// PR5: 护栏运行时状态 — 前端可见
			isStarted: this.isStarted,
			currentRoundId: p.currentRoundId ?? null,
			consecutiveFailures: this.consecutiveFailures,
			peakValue: this.peakValue,
			// 护栏阈值 (前端可以展示 "余额 < $30 暂停" 等)
			sgMinBalance: SAFEGUARD_CONFIG.minBalance,
			sgMaxLossPct: SAFEGUARD_CONFIG.maxLossPct,
			sgCircuitBreakerFails: SAFEGUARD_CONFIG.circuitBreakerFails,
			sgSweepCloseDust: SAFEGUARD_CONFIG.sweepCloseDust
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
