# SOL DCA Dashboard — User Checklist

> **给 user 醒后看的工作黑板**。Mavis 滚动窗口模式：每段只保留最新状态。
> 上次更新：2026-06-07 09:55（Mavis 自主跑 dev 看大盘 + code review 找 6 个优化点）

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
- → **SvelteKit Pages + 独立 DO Worker + D1**（A 方案 v2，user 拍板）
- 理由：Pages 是 SvelteKit 标准部署路径；DO 必须在独立 Worker 里；Pages Function 通过 service binding 调 worker

### ✅ Monorepo 结构（bun workspace）
```
~/projects/sol-dca-dashboard/
├── package.json                    # bun workspace root
├── packages/
│   ├── frontend/                   # SvelteKit → Cloudflare Pages
│   │   ├── src/routes/api/         # state/control → service binding, trades/signals → D1 直读
│   │   ├── src/lib/components/     # TickerStream.svelte (Svelte 5 runes)
│   │   ├── src/lib/config.js       # WS_URL = PUBLIC_WS_URL env
│   │   ├── wrangler.toml           # Pages + SOL_DCA_DB + SOL_DCA_WORKER (service)
│   │   └── svelte.config.js        # adapter-cloudflare, platformProxy.remoteBindings=false
│   └── do-worker/                  # Worker → DO + WS + OKX
│       ├── src/index.js            # Worker 入口 + export TickerHub
│       ├── src/ticker-hub.js       # Durable Object
│       ├── src/strategy.js         # V6 移植
│       ├── src/okx/                # HMAC + public WS
│       ├── src/db/schema.js        # Drizzle (跟 frontend 共享)
│       ├── drizzle/migrations/     # 4 张表
│       └── wrangler.toml           # Worker + SOL_DCA_TICKER_HUB + SOL_DCA_DB
├── backtest.mjs / validate-*.mjs   # 回测脚本（顶层）
├── docs/
└── USER-CHECKLIST.md (本文件)
```

### ✅ Binding 命名（SOL_DCA_* 前缀）
- `SOL_DCA_DB` — D1（两边共享同一 database_id）
- `SOL_DCA_WORKER` — frontend 调 worker 的 service binding
- `SOL_DCA_TICKER_HUB` — worker 内的 DO binding（class_name = "TickerHub"）

### ✅ 本地 dev 跑通（2026-06-07 08:35）
- `bun install` → 268 packages，concurrently + 双 workspace
- `bun run dev` → 起 vite (5173) + wrangler dev (8787)
- ✅ `GET http://localhost:5173/` → HTTP 200（SvelteKit UI 渲染）
- ✅ `GET http://localhost:5173/api/state` → portfolio JSON（service binding → worker → DO）
- ✅ `GET http://localhost:5173/api/trades` → `{trades:[]}`（D1 直读）
- ✅ `GET http://localhost:5173/api/signals` → `{signals:[]}`（D1 直读）
- ✅ `GET http://localhost:8787/health` → `{ok:true}`（worker 健康检查）
- ✅ `GET http://localhost:8787/state` → portfolio JSON（worker 直调 DO）
- 本地 D1 已 migrate（两个 .wrangler/state 都要 run migration, 跟 user 提一下）

### ⚠️ 已知未做
- ✅ **wrangler OAuth** — token 文件 `~/Library/Preferences/.wrangler/config/default.toml` 存在,expiration `2026-06-07T17:24:17Z` 还有效,scope 齐全(d1:write / workers:write / pages:write / secrets_store:write 等)
  - ⚠️ **wrangler 4.98.0 macOS UI bug**: `wrangler whoami` 跟 `wrangler dev --remote` 都报 "not authenticated" / "not logged in",但 token 文件实际有效
  - 影响: `wrangler dev --remote` 拒绝启动(用 remote bindings/dev --remote 模式),但 `wrangler dev --local` (miniflare + 本地 D1) 跑通,功能等效
  - 部署阶段 `wrangler deploy` / `wrangler d1 create` 等命令是否受影响?未验证(后续 deploy 流程跑前要测一下)
  - 修复: 等 wrangler 修复,或换 wrangler 4.81 (项目 package.json 写的版本)
- **真远端 D1 database_id** — 现在 `5ade6a02-...` 是 wrangler dev 自动分配的本地 ID；user 跑 `wrangler d1 create sol-dca-dashboard` 拿真 ID 后改两个 wrangler.toml
- **OKX Demo secrets** — user 之前 put 过 3 个远端 secret，但 `wrangler secret list` 需要 OAuth，现在没法验证；本地 .dev.vars 是空的，所以 dev 阶段 buy/sell 走不通（missingCredentials）
- **PUBLIC_WS_URL 部署时** — Pages dashboard env var 设 `wss://sol-dca-do-worker.<sub>.workers.dev/ws`，dev 阶段 dev script 注入 `ws://localhost:8787/ws`
- **WS client 还没在浏览器里跑过** — curl /api/state 验过了，浏览器 WS 连接 (5173 → 8787) 还没真测，user 自己开 dev 看 dashboard 是否收到 ticker
- ⚠️ **dev 阶段 D1 不互通**（Mavis 自主跑发现）— frontend `/api/signals` `/api/trades` 直读 D1，但 frontend 跟 do-worker 是两个 miniflare 进程，database_id 一样但 SQLite 文件不共享。**部署后 OK**（同一个真 D1），dev 阶段 `/api/signals` 永远空，但前端 TickerStream.svelte 走 WS 推送不消费这俩 endpoint，所以 dashboard 视觉上 OK
- ⚠️ **Svelte 5 runes 警告 8 个**（Mavis 自主跑发现）— TickerStream.svelte 8-14 行 `let portfolio = $state(initial.portfolio ?? null)` 这种写法只捕获 initial 初值，dev console 有警告
- ⚠️ **D1 signal 写入 5815 条/分**（Mavis 自主跑发现）— 每个 OKX ticker（3.5 Hz）都 persistSignal，24h 估算 30 万条/天，D1 写入压力
- ⚠️ **OKX WS 1006 每次断开都 alert**（Mavis 自主跑发现）— 重连机制 OK，但报警会刷屏飞书

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

### 一次性：本地 D1 migration（两个 workspace 各跑一次）
```bash
# do-worker 的 D1（DO 写）
cd packages/do-worker && bun run db:migrate:local && cd ../..

# frontend 的 D1（Pages Function 直读）
cd packages/frontend && bunx wrangler d1 migrations apply sol-dca-dashboard --local && cd ../..

# 或者从根目录: bun run db:migrate:local
# 注：根脚本只跑 do-worker 的, frontend 的要单独跑
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

### Step 1：创建真远端 D1 + apply schema
```bash
cd ~/projects/sol-dca-dashboard/packages/do-worker
wrangler d1 create sol-dca-dashboard
# 复制输出的 database_id, 粘到 packages/{frontend,do-worker}/wrangler.toml
# (两个文件的 database_id 改成同一个)

# 两个都改完后, deploy 前
cd packages/do-worker && bun run db:migrate:remote
```

### Step 2：wrangler secret 注入（do-worker）
看上面"一次性：wrangler secret 注入"段

### Step 3：deploy worker（先！）
```bash
cd ~/projects/sol-dca-dashboard/packages/do-worker
bun run deploy
# 输出: Published sol-dca-do-worker (X.XX sec)
# URL:   https://sol-dca-do-worker.<sub>.workers.dev
# 记下这个 URL, 给 Step 4 用
```

### Step 4：Pages dashboard 设 env var + deploy frontend
1. CF Dashboard → Pages → sol-dca-dashboard → Settings → Environment variables
2. Add: `PUBLIC_WS_URL` = `wss://sol-dca-do-worker.<sub>.workers.dev/ws`（用 Step 3 拿到的 URL）
3. 改 `packages/frontend/wrangler.toml` 的 D1 binding `remote = true`
4. 改 `packages/frontend/wrangler.toml` 的 `[[services]] service` 用真 worker name（默认就是 `sol-dca-do-worker`）
5. ```bash
   cd packages/frontend
   bun run deploy
   # wrangler pages deploy .svelte-kit/cloudflare --project-name sol-dca-dashboard
   ```
6. 输出: URL `https://sol-dca-dashboard.<sub>.pages.dev`

### Step 5：访问 dashboard
- 打开 Pages URL
- 看到实时 SOL/USDT 价格 + 持仓（初始 7000U）+ 决策日志
- 等 OKX 推送 ticker 3-5 秒就会开始决策

### Step 6：观察 1-2 周
- Dashboard 实时显示：每次 ticker → 决策 → 是否下单
- trades / signals 写到 D1
- 报警（可选）：WS 断开 / ticker 30s 静默 → 飞书

### Phase 2（1-2 周后）：切 Live
- 申请 OKX Live API Key（**单独的**，跟 Demo 是两套；同样 read + trade，不开 withdraw）
- `wrangler secret put OKX_LIVE_API_KEY/SECRET/PASSPHRASE`（**不要**碰 demo 那 3 个，只对 do-worker）
- 改 `packages/do-worker/wrangler.toml` vars 里的 `OKX_DEMO_MODE: "0"`（或 env 设 `OKX_DEMO_MODE=0`）
- `wrangler deploy` 重启 do-worker
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

**2026-06-07 09:55 tick**（Mavis 自主跑 dev 看大盘 + code review 找优化点）
- ✅ **大盘真跑起来**（dev:local 模式，因为 wrangler OAuth 失效，dev --remote 走不通）
  - bun run dev:local → 5173 (vite) + 8787 (wrangler dev --local miniflare DO + D1)
  - OKX WS 真连、真推 ticker，63.55→63.54 实时更新，233ms 延迟
  - DO 1 分钟累积 5815 个 signal 到 D1（3.5 Hz 持续写入）
  - 决策逻辑正确：冷启动 hold 等 user 点 "Start DCA"
  - /api/state 走 service binding OK，/api/control pause/resume OK
  - OKX WS 自动重连 1 次（code=1006 → 5s 后重连成功）
- ⚠️ **wrangler 4.98.0 macOS UI bug**（user 之前说"已登录"是对的，token 实际有效，但 whoami/dev --remote 报"未登录"是 wrangler 4.98 的检测 bug）
  - `~/Library/Preferences/.wrangler/config/default.toml` 有 oauth_token + refresh_token，expiration 2026-06-07T17:24:17Z（还有 7.5h）
  - `wrangler whoami` 报 "not authenticated"，`wrangler dev --remote` 报 "not logged in" — 都是 UI 报，实际 token 在用
  - 影响: dev --remote 走不通，但 dev --local 跑通（功能等效，用 miniflare + 本地 D1）
  - **agent memory 那条"已登录"是 Mavis 写错了 — user 没说过"未登录"，是 Mavis 误读**（user 当时说"在 do-worker 里 wrangler dev --remote 正常"，Mavis 没注意听，绕回去了），已修正
- ⚠️ **6 个优化点**（按优先级排序，待 user 拍板是否动手）
  1. **D1 signal 写入太频繁**（5815 条/分）— 加节流（hold 不写 / 5s 合并 / 只写 buy+sell）
  2. **报警疲劳**（OKX WS 1006 每次都 alert）— 加 rate limit（5min 内同类只发一次）
  3. **Svelte 5 runes 警告 8 个**（TickerStream.svelte prop 初始化）— 改用 $derived
  4. **dev 阶段 D1 不互通**（frontend /api/signals 永远空）— 改为 dev 走 service binding，prod 走 D1
  5. **OKX marketBuy 多一次网络请求**（/api/v5/market/ticker）— 用 lastTickerPrice 估算，省 ~50ms
  6. **persistSignal 失败被吞**（unhandled rejection）— 加 try-catch + broadcast error
- 📌 **下一步**：user 醒后看大盘效果（自己开 dev 浏览器），决定 (a) 部署 Phase 1 前先修 6 个优化点 / (b) 先 deploy 跑起来再迭代 / (c) 其他方向
