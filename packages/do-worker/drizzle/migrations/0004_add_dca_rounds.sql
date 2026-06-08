-- 0004_add_dca_rounds.sql
-- PR5 (2026-06-08): 加 dca_rounds 表 — 记录每轮 DCA 生命周期 + P&L
--
-- 背景 (PR5 之前):
--   SOL DCA dashboard 缺"轮次"概念, 只能看 portfolio 当前状态. 无法回答:
--     - 这一轮 DCA 投了多少? 收益多少? 持续了多久?
--     - 上一次手动 close 之后, 重新启动时表现如何?
--     - 自动 sweep_close (manual_sell 清光 SOL) 触发了多少次?
--   所有 history 都在 portfolio_state 单行里, reset / close_round 都丢
--
-- 修复 (PR5):
--   - 新表 dca_rounds, 21 字段记录每轮生命周期
--   - portfolio_state 加 current_round_id INTEGER 外键 (0005_add_current_round_id.sql)
--   - DO SQLite + D1 共享同一份 schema (CREATE TABLE IF NOT EXISTS idempotent)
--   - P0-3: 不 destructive, 老 row 不动 (P0-2 已经修过 peak_price, 这次一样)
--
-- 字段对照 (跟 Drizzle schema 同步, db/schema.js):
--   round_uuid: TEXT UNIQUE, 应用层 crypto.randomUUID() 生成
--   started_at: TEXT NOT NULL, ISO 8601, init_dca handler 写
--   ended_at: TEXT NULL, close_round handler 写, null = open
--   start_price: REAL NOT NULL, init_dca 时 lastTickerPrice
--   end_price: REAL NULL, close_round 时 lastTickerPrice
--   initial_usdt / initial_sol: REAL, init_dca 时 portfolio 余额快照
--   final_usdt / final_sol: REAL NULL, close_round 时 portfolio 余额快照
--   total_spent / total_sold: REAL, 累计 buy/sell USDT (冗余 portfolio_state 字段, 给 dashboard 展示)
--   total_buys / total_sells: INTEGER, 累计 buy/sell 笔数 (冗余, 给 dashboard 展示)
--   realized_pnl / unrealized_pnl / total_return_pct: REAL, P&L 三件套
--   status: TEXT NOT NULL DEFAULT 'open', 'open' | 'closed'
--   close_reason: TEXT NULL, 'manual_close' | 'manual_sell_all' | 'user_reset' | 'auto'
--   mode: TEXT NOT NULL DEFAULT 'demo', 'demo' | 'live'
--   notes: TEXT NULL, init_dca handler 接受 user 自定义备注
--   updated_at: TEXT NOT NULL, 每次 UPDATE 改

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

CREATE INDEX IF NOT EXISTS idx_dca_rounds_status ON dca_rounds (status);
CREATE INDEX IF NOT EXISTS idx_dca_rounds_started_at ON dca_rounds (started_at DESC);