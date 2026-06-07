# SOL DCA Dashboard — User Checklist

> **给 user 醒后看的工作黑板**。Mavis 滚动窗口模式：每段只保留最新状态。
> 上次更新：2026-06-07 16:10（Mavis 修 schema 漂移 + 5 项 UX 优化 + 2 个 strategy bug 修）

---

## 🎯 成果（今天完成的）

### ✅ V1-V9 回测 + WebSocket 验证
- **V1-V8**：多轮策略验证（参数扫描、分批回本、12 组合对比、当前价位入场）
- **V9**：OKX WebSocket 推送验证（3.57 Hz / 1.76s 延迟 / 60s 214 次推送 → 对 5% 触发策略够用）
- **🏆 锁定策略**：E + r0.5_s0.3_n3
  - 5% 跌幅触发首买 $30
  - 1-5x 加码（跌得越多买越多）
  - 月度上限 $500U
  - 分批回本：+50% / +100% / +150% 各卖 30%（累计 90%，留 10% 底仓）
  - 6 窗口平均收益 +27.8% / 平均回撤 -0.8%
- **V8 副结论**：SOL 平均 +143.4% > XRP +5%，SOL 更适合 DCA

### ✅ 架构定型（user 拍板 + Mavis 修正）
- ~~SvelteKit 塞 Worker + DO~~（A 方案 v1，Mavis 错的选择）
- → **SvelteKit Pages + 独立 DO Worker**（A 方案 v2，user 拍板）
- 理由：Pages 是 SvelteKit 标准部署路径；DO 必须在独立 Worker 里；Pages Function 通过 service binding 调 worker

### ✅ Monorepo 结构（bun workspace）
```
~/projects/sol-dca-dashboard/
├── package.json                    # bun workspace root
├── packages/
│   ├── frontend/                   # SvelteKit → Cloudflare Pages
│   │   ├── src/routes/api/         # state/control/signals/trades/reset → service binding → DO
│   │   ├── src/lib/components/     # TickerStream.svelte (Svelte 5 runes)
│   │   ├── src/lib/config.js       # WS_URL = PUBLIC_WS_URL env
│   │   ├── wrangler.toml           # Pages + SOL_DCA_WORKER (service)
│   │   └── svelte.config.js        # adapter-cloudflare, platformProxy.remoteBindings=false
│   └── do-worker/                  # Worker → DO + WS + OKX
│       ├── src/index.js            # Worker 入口 + export TickerHub
│       ├── src/ticker-hub.js       # Durable Object
│       ├── src/strategy.js         # V6 移植
│       ├── src/okx/                # HMAC + public WS
│       ├── src/db/schema.js        # Drizzle (跟 frontend 共享)
│       ├── drizzle/migrations/     # 4 张表
│       └── wrangler.toml           # Worker + SOL_DCA_TICKER_HUB
├── backtest.mjs / validate-*.mjs   # 回测脚本（顶层）
├── docs/
└── USER-CHECKLIST.md (本文件)
```

### ✅ Binding 命名（SOL_DCA_* 前缀）
- `SOL_DCA_WORKER` — frontend 调 worker 的 service binding
- `SOL_DCA_TICKER_HUB` — worker 内的 DO binding（class_name = "TickerHub"）

### ✅ 本地 dev 跑通（2026-06-07 08:35）
- `bun install` → 268 packages，concurrently + 双 workspace
- `bun run dev` → 起 vite (5173) + wrangler dev (8787)
- ✅ `GET http://localhost:5173/` → HTTP 200（SvelteKit UI 渲染）
- ✅ `GET http://localhost:5173/api/state` → portfolio JSON（service binding → worker → DO）
- ✅ `GET http://localhost:5173/api/trades` → `{trades:[]}`（service binding → DO storage）
- ✅ `GET http://localhost:5173/api/signals` → `{signals:[]}`（service binding → DO storage）
- ✅ `GET http://localhost:8787/health` → `{ok:true}`（worker 健康检查）
- ✅ `GET http://localhost:8787/state` → portfolio JSON（worker 直调 DO）

### ⚠️ 已知未做
- ✅ **wrangler OAuth** — 已解决，`wrangler dev --remote` 正常可用
- **OKX Demo secrets** — 本地 .dev.vars 空的，dev 阶段 buy/sell 走不通（missingCredentials）；远端 secret 已 put 过，部署后自动生效
- **PUBLIC_WS_URL 部署时** — Pages dashboard env var 设 `wss://sol-dca-do-worker.<sub>.workers.dev/ws`，dev 阶段 dev script 注入 `ws://localhost:8787/ws`
- ⚠️ **OKX WS 1006 每次断开都 alert**（Mavis 自主跑发现）— 重连机制 OK，但报警会刷屏飞书

### ✅ 本 session 修了（2026-06-07 10:00-16:10）
- **🎯 重大：DO schema 漂移修复** — 4 个 schema 源 (db/schema.js / 0000_initial.sql / 0000_snapshot.json / worker SQL_SCHEMA) 4 个不同状态。`sell_stairs_triggered` / `okx_fee` / `intended_amount_usdt` 在 DO SQLite 不一致 → persistTrade silent fail (try/catch 吞) → 数据丢失。统一改 `portfolio_state` 名字，Drizzle / SQL migration / worker SQL / worker raw SQL 全部对齐。dev destructive 重建验证：触发 init_dca 后数据正确。V6 sell stairs 状态机现在 DO 重启后能正确恢复，不会丢
- ✅ **signal 写入太频繁** (5815 条/分) — hold 加 rate limit: 30s 心跳 + 0.2% 价格变化补一条。Buy/Sell/Skip 立刻记
- ✅ **Svelte 5 runes 警告 8 个** — TickerStream.svelte 改成 $state + $derived (P&L 实时算 live, 不依赖 server snapshot)
- ✅ **OKX marketBuy 多一次网络请求** — 用 lastTickerPrice 估算，省 ~50ms
- ✅ **persistSignal 失败被吞** — DO try/catch + broadcast error, 失败不静默
- ✅ **"决策日志 + 最近成交" 跟"完整历史"重复** — 删两块, 完整历史是唯一 history view
- ✅ **页面外背景只一块** — +layout.svelte 全局 :global(html, body) 黑色
- ✅ **手机优先 UI** — 完整 media query, portfolio 单列 + 触摸 44px + 表格横滑
- ✅ **PC 端界面外背景只一块** — body 全黑
- ✅ **refresh 按钮位置** — 挪到 USDT/SOL card 顶部
- ✅ **P&L 不跟 ticker 实时更新** — $derived 实时算, live dot 标识
- ✅ **trades 一刷新就空** — hello 消息加 recentSignals/recentTrades, 跟 /state 对齐
- ✅ **SCHEMA_SQL 拼错** — pre-existing typo, applyMigrations 改 SQL_SCHEMA 正确
- ✅ **"未触发 + 余额不足" 文案错** — 4 种 hold 情况分文案 (跌幅不足 / 月度上限 / 余额不足 / 冷启动)

---

## 💰 盈利
*Phase 1 模拟盘阶段，0 资金流动*
*真实盈亏从 Phase 2 切 Live 时开始记录*

---

## 🏃 本地开发

### 一次性：装依赖
```bash
cd ~/projects/sol-dca-dashboard
bun install
```

### 一次性：申请 OKX Demo Trading API Key
1. 登录 https://www.okx.com
2. 顶部"交易" → "模拟交易"
3. 设置 → 账户模式 → **单币种保证金模式**
4. 用户 → "模拟交易 API" → "申请模拟交易 V5 API"
5. **权限：read + trade，❌ 不开 withdraw**
6. 记录：API Key / API Secret / Passphrase

### 一次性：wrangler secret 注入（**只对 do-worker**）
```bash
cd packages/do-worker
wrangler secret put OKX_DEMO_API_KEY
wrangler secret put OKX_DEMO_API_SECRET
wrangler secret put OKX_DEMO_PASSPHRASE
# 可选: wrangler secret put ALERT_WEBHOOK_URL
```

### 开发模式
```bash
# 根目录一键起两边（concurrently）
cd ~/projects/sol-dca-dashboard
bun run dev

# 浏览器开 http://localhost:5173 看 dashboard
# WS 自动连 ws://localhost:8787/ws（PUBLIC_WS_URL 注入）
```

### dev 阶段只跑一边
```bash
bun run dev:frontend   # 只起 vite (5173)
bun run dev:worker     # 只起 wrangler dev (8787)
```

---

## 🚀 部署（Phase 1: Demo Trading）

### Step 0：wrangler login
```bash
wrangler login
# 浏览器走 OAuth, 落本地 token
```

### Step 1：wrangler secret 注入（do-worker）
看上面"一次性：wrangler secret 注入"段

### Step 2：deploy worker（先！）
```bash
cd ~/projects/sol-dca-dashboard/packages/do-worker
bun run deploy
# 输出: Published sol-dca-do-worker (X.XX sec)
# URL:   https://sol-dca-do-worker.<sub>.workers.dev
# 记下这个 URL, 给 Step 4 用
```

### Step 3：Pages dashboard 设 env var + deploy frontend
1. CF Dashboard → Pages → sol-dca-dashboard → Settings → Environment variables
2. Add: `PUBLIC_WS_URL` = `wss://sol-dca-do-worker.<sub>.workers.dev/ws`（用 Step 2 拿到的 URL）
3. 改 `packages/frontend/wrangler.toml` 的 `[[services]] service` 用真 worker name（默认就是 `sol-dca-do-worker`）
5. ```bash
   cd packages/frontend
   bun run deploy
   # wrangler pages deploy .svelte-kit/cloudflare --project-name sol-dca-dashboard
   ```
6. 输出: URL `https://sol-dca-dashboard.<sub>.pages.dev`

### Step 4：访问 dashboard
- 打开 Pages URL
- 看到实时 SOL/USDT 价格 + 持仓（初始 7000U）+ 决策日志
- 等 OKX 推送 ticker 3-5 秒就会开始决策

### Step 5：观察 1-2 周
- Dashboard 实时显示：每次 ticker → 决策 → 是否下单
- trades / signals 写到 DO storage
- 报警（可选）：WS 断开 / ticker 30s 静默 → 飞书

### Phase 2（1-2 周后）：切 Live
- 申请 OKX Live API Key（**单独的**，跟 Demo 是两套；同样 read + trade，不开 withdraw）
- `wrangler secret put OKX_LIVE_API_KEY/SECRET/PASSPHRASE`（**不要**碰 demo 那 3 个，只对 do-worker）
- 改 `packages/do-worker/wrangler.toml` vars 里的 `OKX_DEMO_MODE: "0"`（或 env 设 `OKX_DEMO_MODE=0`）
- `wrangler deploy` 重启 do-worker（Step 2）
- 真实盈亏从这一刻开始

**Phase 1 vs Phase 2 规则**（只列 user 显式说过的）：
- ✅ Phase 1 = Demo 跑 1-2 周，**本金不预设**（用 OKX API 查账户实际余额）
- ✅ Phase 2 = Live 实际本金**待 user 拍板**（不是 Mavis 锁死 1万U）
- ✅ **分批回本 r0.5_s0.3_n3**（+50%/+100%/+150% 各卖 30%）
- ❌ "利润到 4000 USDT 触发分批回本" — **Mavis 编造**，已删除
- ❌ "Phase 2 必须 1万U" — **Mavis 编造**，已删除
- ❌ "分批回本 +200%" — **Mavis 编造**，V6 实际是 +150%（stairRatios [0.5, 1.0, 1.5]）

---

## 📋 USER_BLOCK

<!-- user 醒后在这里写自己想加的（例如：补充 1-2 周后的新约束、修改阈值等） -->

---

## 📊 MAVIS_LOG（滚动窗口 = 最近 1 条）

**2026-06-07 16:10 tick**（user 4 轮集中反馈 UX + strategy bug 修复 + schema 对齐）
- 🎯 **schema 漂移全修齐** — 4 个 schema 源对齐，dev destructive 重建后数据正确。V6 sell stairs 状态机 DO 重启后能正确恢复
- 🎯 **完整历史** section — 合并决策+成交, 4 个 filter (全部/决策/成交/hold), WS push 实时 prepend, 删了重复的"决策日志 + 最近成交"两块
- 🎯 **P&L 实时跟 ticker** — $derived 算 liveCurrentValue / liveProfit / liveProfitPct / liveUnrealizedPnL
- 🎯 **5 项 UX 改进** — 黑底 / 手机优先 / refresh 按钮顶部 / 完整历史保留 / 实时 P&L
- 🎯 **2 个 strategy bug** — "未触发 + 余额不足" 文案分 4 种情况; hold rate limit (30s 心跳 + 0.2% 价格)
- 🎯 **trades 刷新就空** — hello 消息补 recentSignals/recentTrades
- 📌 **下一步**：等 user 拍板 commit + deploy (TOTP 2FA / 切 live 之前先做)
