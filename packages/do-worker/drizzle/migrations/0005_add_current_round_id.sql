-- 0005_add_current_round_id.sql
-- PR5 (2026-06-08): portfolio_state 加 current_round_id 列
--
-- 跟 0004_add_dca_rounds.sql 配套 — portfolio_state.current_round_id 是 dca_rounds.id 的外键
--   - init_dca handler 写 (openDcaRound 返回 roundId 后)
--   - close_round handler 清 (closeDcaRound 内部)
--   - DO 冷启动时 loadPortfolio 读这一列恢复 isStarted=true (PR5 UX 改进)
--
-- SQLite ALTER TABLE ADD COLUMN 是 idempotent-safe (列已存在会报错, 需 try/catch 包裹)
-- 老 D1 row 没有此列 → rowToPortfolio 读出来 row.current_round_id = undefined → 序列化为 null
-- loadPortfolio 跟 isStarted/currentRoundId 同步, 走 null fallback 路径

ALTER TABLE portfolio_state ADD COLUMN current_round_id INTEGER;