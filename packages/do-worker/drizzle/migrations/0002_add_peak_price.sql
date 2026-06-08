-- 0002_add_peak_price.sql
-- P0-2 fix: drawdownPct uses peak (高位建仓后熊市初期不漏 DCA)
--
-- 加 `peak_price REAL` 列到 portfolio_state, 跟 last_buy_price 同步语义:
--   - 冷启动 (未建仓): peak_price = NULL → decide() fallback 到 last_buy_price (旧逻辑等价)
--   - 首次 buy: applyBuy 设 peak_price = price (= last_buy_price)
--   - 持续跟踪: 每个 ticker 推送 max(peak_price, ticker.last), 反映"建仓以来最高"
--   - reset: peak_price = NULL (跟 last_buy_price 同步清)
--
-- SQLite ALTER TABLE ADD COLUMN 是 idempotent-safe (列已存在会报错, 需 try/catch 包裹)
-- 老 D1 row 没有此列 → rowToPortfolio 读出来 row.peak_price = undefined → 序列化为 null,
--   decide() 仍 fallback 到 last_buy_price, 不破坏行为

ALTER TABLE portfolio_state ADD COLUMN peak_price REAL;