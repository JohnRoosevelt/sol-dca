# SOL DCA Dashboard

> SOL DCA 定投机器人 — 实时监控 + 自动低买分批回本。部署在 Cloudflare Edge（SvelteKit Pages + Durable Object Worker）。
**当前策略**：E_d5p_5x + r0.5_s0.3_n3

**Phase 1**：OKX 模拟盘，无真实资金流动

---

## 架构

```
Browser ──WS──> do-worker (Durable Object TickerHub) ──WS──> OKX Public
                  |
                  ├── 策略决策 (decide)
                  ├── OKX Private REST (下单/查余额)
                  ├── DO SQLite (持久化)
                  └── ──WS──> Browser (TickerStream.svelte)

Browser ──HTTP──> SvelteKit Pages (SSR + API 代理)
                  | via service binding (SOL_DCA_WORKER)
                  └── ── ── ─ ─ ─ ─ ─ ─ ─ ─ ─ ─> do-worker
```

| 组件 | 技术 | 端口（dev） |
|------|------|------------|
| Frontend | SvelteKit 5 + Cloudflare Pages | http://localhost:5173 |
| DO Worker | Cloudflare Workers + Durable Objects | http://localhost:8787 |

**关键设计**：
- Cloudflare Pages Functions 不支持 WebSocket upgrade，浏览器直连 worker URL（wss://sol-dca-do-worker.<account>.workers.dev/ws）
- Pages Function 通过 **service binding** 直连 do-worker（Cloudflare 内部网络，极低延迟）
- demo / live 用两个独立 DO instance（sol-usdt-demo / sol-usdt-live），数据物理隔离

---

## 快速开始

### 1. 装依赖

```bash
cd ~/projects/sol-dca-dashboard
bun install
```

### 2. 配置 OKX Demo 凭证

1. 登录 https://www.okx.com -> 交易 -> 模拟交易
2. 账户模式设为**单币种保证金模式**
3. 申请模拟交易 V5 API（权限：read + trade，不开 withdraw）
4. 记录 API Key / API Secret / Passphrase

### 3. 填本地凭证

```bash
# packages/do-worker/.dev.vars  (gitignore)
OKX_DEMO_MODE=1
OKX_DEMO_API_KEY=你的key
OKX_DEMO_API_SECRET=你的secret
OKX_DEMO_PASSPHRASE=你的passphrase

# packages/frontend/.dev.vars  (gitignore)
PUBLIC_WS_URL=ws://localhost:8787/ws
```

### 4. 启动

```bash
bun run dev
# 同时起 vite (5173) + wrangler dev (8787)
```

打开 http://localhost:5173

---

## 环境变量

### .dev.vars（本地 dev，gitignore）

| 文件 | 变量 | 说明 |
|------|------|------|
| packages/do-worker/.dev.vars | OKX_DEMO_API_KEY | OKX 模拟盘 API Key |
| | OKX_DEMO_API_SECRET | OKX 模拟盘 API Secret |
| | OKX_DEMO_PASSPHRASE | OKX 模拟盘 Passphrase |
| | OKX_DEMO_MODE=1 | Phase 1 固定写 1 |
| packages/frontend/.dev.vars | PUBLIC_WS_URL | 本地 worker：ws://localhost:8787/ws |

### wrangler.toml vars（部署后生效）

| 文件 | 变量 | 说明 |
|------|------|------|
| packages/do-worker/wrangler.toml | OKX_PUBLIC_WS | OKX 公共 WS URL |
| packages/frontend/wrangler.toml | PUBLIC_WS_URL | 部署后 worker 的 wss:// URL |
| | SOL_DCA_WORKER | service binding -> do-worker |

### wrangler secrets（wrangler secret put，不落文件）

```bash
cd packages/do-worker
wrangler secret put OKX_DEMO_API_KEY
wrangler secret put OKX_DEMO_API_SECRET
wrangler secret put OKX_DEMO_PASSPHRASE
# 可选：wrangler secret put ALERT_WEBHOOK_URL  (飞书/Bark/通用 JSON)

cd packages/frontend
wrangler secret put PUBLIC_TOTP_SECRET
```

Phase 2 切 Live 时再加：
```bash
wrangler secret put OKX_LIVE_API_KEY
wrangler secret put OKX_LIVE_API_SECRET
wrangler secret put OKX_LIVE_PASSPHRASE
```

---

## 策略参数

**策略 ID**：E_d5p_5x_r0.5_s0.3_n3

### DCA 入场

| 参数 | 值 | 说明 |
|------|-----|------|
| baseAmount | $30 | 首买金额 |
| triggerPct | 5% | 从 lastBuyPrice 跌幅 >= 5% 触发 |
| monthLimit | $500 | 月度 DCA 上限 |

**加码倍数**（跌得越多买越多）：

| 跌幅 | 倍数 | 买入金额 |
|------|------|---------|
| >= 5% | 1x | $30 |
| >= 10% | 2x | $60 |
| >= 20% | 3x | $90 |
| >= 30% | 4x | $120 |
| >= 50% | 5x | $150 |

### 分批回本

| 参数 | 值 | 说明 |
|------|-----|------|
| sellTriggerBase | 0.5 (+50%) | 回本基准比例 |
| sellPct | 30% | 每档卖出持仓比例 |
| stairCount | 3 | 3 档（累计卖 90%，留 10% 底仓） |

**触发档位**：

| 档位 | 浮盈触发 | 卖出比例 | 累计卖出 |
|------|---------|---------|---------|
| 第 1 档 | +50% | 30% | 30% |
| 第 2 档 | +100% | 30% | 60% |
| 第 3 档 | +150% | 30% | 90% |

浮盈 = (现价 - avgBuyPrice) × solHolding，基于未实现浮盈计算。

### 其他机制

- **冷启动**：未建立 lastBuyPrice 前所有 ticker 只广播价格，不下单，等用户点"启动 V6"
- **安息日保护**：柏林 SDA 安息日（周五 17:00 UTC ~ 周六 17:00 UTC）跳过所有 DCA 决策
- **月度重置**：每月 1 日 00:00 UTC 清零 monthSpent

---

## 目录结构

```
sol-dca-dashboard/
├── package.json                        # bun workspace root
│
├── packages/
│   ├── frontend/                       # SvelteKit → Cloudflare Pages
│   │   ├── src/
│   │   │   ├── routes/
│   │   │   │   ├── +page.svelte        # 根页面
│   │   │   │   ├── +page.server.js     # SSR load，service binding 拉初始 state
│   │   │   │   └── api/                # API 代理（state/control/signals/trades/reset）
│   │   │   ├── lib/
│   │   │   │   ├── components/
│   │   │   │   │   └── TickerStream.svelte   # 主 UI 组件（Svelte 5 runes）
│   │   │   │   └── config.js           # WS_URL = PUBLIC_WS_URL env
│   │   │   └── hooks.server.js
│   │   ├── wrangler.toml               # Pages 配置 + SOL_DCA_WORKER service binding
│   │   └── svelte.config.js            # adapter-cloudflare
│   │
│   └── do-worker/                      # Cloudflare Worker + Durable Object
│       ├── src/
│       │   ├── index.js                # Worker 入口，路由 /ws /state /control /reset
│       │   ├── ticker-hub.js           # Durable Object TickerHub（全实现）
│       │   ├── strategy.js             # V6 策略 decide() + applyBuy/applySell
│       │   ├── alert.js                # Feishu/Bark/通用 JSON 报警 + rate limit
│       │   ├── sabbath.js              # 柏林 SDA 安息日判断
│       │   └── okx/
│       │       ├── client.js           # OKX V5 REST 客户端（HMAC-SHA256 签名）
│       │       └── ws-public.js        # OKX 公共 WS 订阅 ticker
│       └── wrangler.toml               # Worker + SOL_DCA_TICKER_HUB binding
│
├── docs/
│   ├── DEPLOYMENT.md                   # 部署指南（本地 dev + 生产部署）
│   ├── ARCHITECTURE.md                 # 技术架构文档
│   └── USER-CHECKLIST.md               # 开发日志和工作记录
│
└── backtest.mjs / validate-*.mjs       # 回测脚本（根目录）
```

---

## 部署

详见 [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)。

**摘要**：

```bash
# 1. wrangler login
wrangler login

# 2. 注入 OKX secrets（do-worker）
cd packages/do-worker
wrangler secret put OKX_DEMO_API_KEY
wrangler secret put OKX_DEMO_API_SECRET
wrangler secret put OKX_DEMO_PASSPHRASE

# 3. 部署 do-worker
bun run deploy
# 记下输出 URL: https://sol-dca-do-worker.<sub>.workers.dev

# 4. 更新 frontend wrangler.toml 的 PUBLIC_WS_URL（prod worker URL）
# 然后部署 frontend
bun run deploy
# 输出: https://sol-dca-dashboard.<sub>.pages.dev
```

Phase 2 切 Live：改 `packages/do-worker/wrangler.toml` 的 `OKX_DEMO_MODE = "0"`，重部署 do-worker，然后注入 `OKX_LIVE_*` 三条 secret。

---

## 技术栈

| 层 | 技术 |
|----|------|
| Frontend | SvelteKit 2 + Svelte 5 runes, Vite, Cloudflare Pages |
| Worker | Cloudflare Workers, Durable Objects (TickerHub) |
| Storage | DO 内置 SQLite（唯一持久化存储） |
| 数据源 | OKX WebSocket (ticker) + OKX REST (下单/余额) |
| 部署 | wrangler |
| Monorepo | bun workspace |
