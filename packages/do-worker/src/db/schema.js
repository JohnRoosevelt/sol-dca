import { integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * 单行持仓状态（id 永远 = 1, CONSTRAINT 由应用层保证）
 *   字段对照 V6 验证的 portfolio_state
 *
 *   注: demo / live 各自一个独立 DO instance, D1 schema 不加 mode 列.
 *   每个 DO 都从 id=1 写自己的 portfolio_state (各管各的, 不冲突).
 *
 *   **DO storage + D1 共享同一份 schema** (V6 关键字段对齐):
 *   - sell_stairs_triggered: V6 分批回本状态机 (JSON 数组, 应用层 Set 序列化)
 *   - 之前 D1 缺这一列 → sell stairs 触发后 DO 重启就丢状态, 现已补齐
 */
export const portfolioState = sqliteTable('portfolio_state', {
	id: integer('id').primaryKey(),
	usdtBalance: real('usdt_balance').notNull().default(0),
	solHolding: real('sol_holding').notNull().default(0),
	avgBuyPrice: real('avg_buy_price'),
	lastBuyPrice: real('last_buy_price'),
	peakPrice: real('peak_price'), // P0-2: 建仓以来最高价 (decide() 用它算 drawdownPct, 高位建仓后熊市初期不漏 DCA)
	totalSpent: real('total_spent').notNull().default(0),
	totalSold: real('total_sold').notNull().default(0),
	realizedPnL: real('realized_pnl').notNull().default(0),
	currentMonthSpent: real('current_month_spent').notNull().default(0),
	currentMonthReset: text('current_month_reset'),
	consecutiveDcaBuys: integer('consecutive_dca_buys').notNull().default(0),
	sellStairsTriggered: text('sell_stairs_triggered').notNull().default('[]'),
	updatedAt: text('updated_at')
		.notNull()
		.$defaultFn(() => new Date().toISOString())
});

/**
 * 交易记录（单边：buy 或 sell）
 * OKX clOrdId 作为唯一键（防重复）— 每个 DO 用不同前缀, 不会跨 mode 撞
 *
 *   **DO storage + D1 共享同一份 schema**:
 *   - okx_fee: OKX 实际手续费 (ccy + amount), audit 用
 *   - intended_amount_usdt: 下单意图金额 (vs realAmountUsdt 实际成交), audit 用
 *   - 之前 D1 缺这两列 → D1 归档 silent fail (try/catch 吞), 现已补齐
 */
export const trades = sqliteTable('trades', {
	id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
	clOrdId: text('cl_ord_id').notNull().unique(),
	side: text('side', { enum: ['buy', 'sell'] }).notNull(),
	price: real('price').notNull(),
	amountUsdt: real('amount_usdt').notNull(),
	amountSol: real('amount_sol').notNull(),
	reason: text('reason').notNull(),
	drawdownPct: real('drawdown_pct'),
	multiplier: real('multiplier'),
	profitPct: real('profit_pct'),
	mode: text('mode', { enum: ['demo', 'live'] }).notNull().default('demo'),
	okxOrderId: text('okx_order_id'),
	okxState: text('okx_state'),
	okxFee: text('okx_fee'),
	intendedAmountUsdt: real('intended_amount_usdt'),
	createdAt: text('created_at')
		.notNull()
		.$defaultFn(() => new Date().toISOString())
});

/**
 * 策略信号日志（不下单时也记录）
 * 用于回测 + dashboard 决策日志展示
 */
export const signals = sqliteTable('signals', {
	id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
	price: real('price').notNull(),
	action: text('action', { enum: ['buy', 'sell', 'hold', 'skip'] }).notNull(),
	reason: text('reason').notNull(),
	drawdownPct: real('drawdown_pct'),
	profitPct: real('profit_pct'),
	usdtAfter: real('usdt_after'),
	solAfter: real('sol_after'),
	mode: text('mode', { enum: ['demo', 'live'] }).notNull().default('demo'),
	createdAt: text('created_at')
		.notNull()
		.$defaultFn(() => new Date().toISOString())
});

/**
 * K 线历史缓存（V11+ 用，先建表）
 * OKX public API 1m K 线，每根一行
 */
export const klines = sqliteTable('klines', {
	id: text('id').primaryKey(),
	instId: text('inst_id').notNull(),
	timeframe: text('timeframe').notNull(),
	openTime: integer('open_time').notNull(),
	open: real('open').notNull(),
	high: real('high').notNull(),
	low: real('low').notNull(),
	close: real('close').notNull(),
	volume: real('volume').notNull()
});
