# P1 Fixes — sol-dca-dashboard

## Fixed

### P1-1: `portfolio_synced` 消息处理不完整
**文件**: `packages/frontend/src/lib/components/TickerStream.svelte`

`portfolio_synced` case 从字段级部分更新改为直接用完整快照替换。
`snapshotPortfolio()` 已经包含所有字段，无需字段级 merge，也无需 `fetchState()` 兜底。

### P1-2: Demo USDT 余额硬编码
**文件**: `packages/frontend/src/lib/components/TickerStream.svelte`

banner 里不再写死 `(USDT 余额 4998.95)`，余额在 portfolio 卡片里动态显示。

### P1-3: Alert cooldown 存在 DO 内存，重启后丢失
**文件**: `packages/do-worker/src/alert.js`

未做代码修改（DO `state.storage` 改造较大），添加了注释说明这是 Durable Object 架构限制，冷启动/版本更新后内存清零是已知行为。后续如需真正持久化，应将 `alertCooldowns` 写入 `state.storage`。

### P1-4: 未使用 CSS 选择器
**文件**: `packages/frontend/src/lib/components/TickerStream.svelte`

删除了 `.value-row` 和 `.value-row .value` 两个未使用 CSS 规则。

### P1-5: `compatibility_date` 是未来日期
**文件**: `packages/do-worker/wrangler.toml` + `packages/frontend/wrangler.toml`

两处 `compatibility_date` 从 `2026-06-06` 改为 `2025-01-01`。

---

## 未修复 / 已知问题

### Build 失败（pre-existing，非本次修改引入）
`bun run build` 在当前仓库状态下失败，错误链：

1. `worker-configuration.d.ts` 与 `wrangler.toml` 不同步 → `wrangler types` 需要先运行
2. 即使手动 `wrangler types` 后，`vite-plugin-sveltekit-guard` 仍报 "An impossible situation occurred"

**验证**: 在末次提交 (`ee38c01`) 上用原始 `worker-configuration.d.ts` 测试，build 同样失败，确认是仓库 pre-existing 问题，与本次 P1 修改无关。

根本原因可能是：
- `wrangler.toml` 改了但 `worker-configuration.d.ts` 未同步更新和提交（git status 显示 `worker-configuration.d.ts` 是 modified 未提交状态）
- SvelteKit + Cloudflare Pages + `@cloudflare/vite-plugin@1.40.0` 组合的兼容性问题

### 其他未使用 CSS 选择器警告（非 P1 范围）
build 输出中还有 `.folded`、`.signals`、`.trades`、`.signals table` 等未使用选择器警告，这些不在 P1 范围内，未处理。

---

## VERDICT: PARTIAL

**理由**:
- P1-1, P1-2, P1-4, P1-5 均已正确修复
- P1-3 按推荐方案（添加注释说明）处理，未做大改
- 仓库 build 在本次修改前已 broken，build 失败非本次修改引入，但 build 未能通过验证要求
