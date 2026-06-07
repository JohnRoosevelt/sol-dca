# SOL DCA Dashboard — 部署文档

## 目录

- [本地开发](#本地开发)
- [生产部署](#生产部署)
- [环境变量一览](#环境变量一览)
- [常见问题](#常见问题)

---

## 本地开发

### 首次：装依赖

```bash
cd ~/projects/sol-dca-dashboard
bun install
```

### 首次：配置 OKX Demo 凭证

1. 登录 https://www.okx.com → 顶部「交易」→「模拟交易」
2. 设置 → 账户模式 → **单币种保证金模式**
3. 用户 →「模拟交易 API」→「申请模拟交易 V5 API」
4. 权限：read + trade，**不开** withdraw
5. 记录 API Key / API Secret / Passphrase

### 首次：填本地凭证

```bash
# packages/do-worker/.dev.vars — OKX API 凭证（gitignore，不上传）
OKX_DEMO_MODE=1
OKX_DEMO_API_KEY=你的key
OKX_DEMO_API_SECRET=你的secret
OKX_DEMO_PASSPHRASE=你的passphrase

# packages/frontend/.dev.vars — WebSocket 连接地址
PUBLIC_WS_URL=ws://localhost:8787/ws
```

### 启动开发服务器

```bash
cd ~/projects/sol-dca-dashboard
bun run dev
# 起两个服务：
#   vite      → http://localhost:5173   (Dashboard UI)
#   wrangler  → http://localhost:8787   (DO Worker，WS 端口)

# 只开一边：
bun run dev:frontend   # 只起 UI (5173)
bun run dev:worker     # 只起 Worker (8787)
```

打开 http://localhost:5173 即可看到实时价格。

---

## 生产部署

### Step 0：wrangler 登录

```bash
wrangler login
# 浏览器弹出 OAuth，确认授权
```

### Step 1：注入 OKX 密钥（do-worker）

```bash
cd packages/do-worker
wrangler secret put OKX_DEMO_API_KEY
wrangler secret put OKX_DEMO_API_SECRET
wrangler secret put OKX_DEMO_PASSPHRASE
# 提示输入值，粘贴对应内容
# OKX_LIVE_* 切 Live 时再填（见 Step 6）
```

### Step 2：部署 do-worker

```bash
cd packages/do-worker
bun run deploy

# 成功输出示例：
# Published sol-dca-do-worker (X.XX sec)
# https://sol-dca-do-worker.john-76f.workers.dev
# ↑ 记下这个 URL，Step 3 用
```

### Step 3：更新 frontend 的 PUBLIC_WS_URL

`packages/frontend/wrangler.toml` 里已有值（Step 2 跑完后确认）：

```toml
[vars]
PUBLIC_WS_URL = "wss://sol-dca-do-worker.john-76f.workers.dev/ws"
```

如果 worker URL 变了，**只改这一行**。

> 注意：`packages/frontend/.dev.vars` 是本地 dev 用的（`ws://localhost:8787/ws`），不参与部署。

### Step 4：部署 frontend

```bash
cd ~/projects/sol-dca-dashboard
bun run deploy
# 等同: bun run build && wrangler pages deploy .svelte-kit/cloudflare --project-name sol-dca-dashboard

# 成功输出：
# https://sol-dca-dashboard.<sub>.pages.dev
# ↑ 这就是你的 Dashboard 线上地址
```

### Step 5：验证

1. 打开 Step 4 的 Pages URL
2. 看到实时 SOL/USDT 价格在跳动 → 说明 WS 连上了
3. USDT 余额显示 → 说明 OKX 凭证对上了
4. 等 3-5 秒，第一个 signal 日志出现 → 策略在运行

---

## 环境变量一览

### `.dev.vars`（本地 dev，gitignore）

| 文件 | 变量 | 说明 |
|------|------|------|
| `packages/do-worker/.dev.vars` | `OKX_DEMO_API_KEY/SECRET/PASSPHRASE` | OKX 模拟盘 API |
| | `OKX_DEMO_MODE=1` | 固定写 1，Phase 1 用 |
| `packages/frontend/.dev.vars` | `PUBLIC_WS_URL` | `ws://localhost:8787/ws`（本地 worker） |

### `wrangler.toml` vars（部署后生效）

| 文件 | 变量 | 值 |
|------|------|-----|
| `packages/do-worker/wrangler.toml` | `OKX_PUBLIC_WS` | `wss://ws.okx.com:8443/ws/v5/public` |
| | `OKX_API_BASE` | `https://www.okx.com` |
| | `OKX_INST_ID` | `SOL-USDT` |
| | `OKX_DEMO_MODE` | `"1"`（Phase 1） |
| `packages/frontend/wrangler.toml` | `PUBLIC_WS_URL` | `wss://sol-dca-do-worker.<sub>.workers.dev/ws`（prod worker） |

### wrangler secret（部署后生效，不在文件里）

```bash
# do-worker 注入（wrangler secret put）
OKX_DEMO_API_KEY
OKX_DEMO_API_SECRET
OKX_DEMO_PASSPHRASE
# 可选：
ALERT_WEBHOOK_URL      # 飞书 / Bark 等
OKX_LIVE_API_KEY       # Phase 2 用
OKX_LIVE_API_SECRET
OKX_LIVE_PASSPHRASE

# frontend 注入（必须用 wrangler secret，不能写进 wrangler.toml）
PUBLIC_TOTP_SECRET     # TOTP 密钥，运行时读取，不 bake 进 bundle
```

### PUBLIC_TOTP_SECRET — 为什么用 dynamic env

SvelteKit 的 `$env` 有两种：
- `$env/static/public` — build 时 bake 进 JS bundle，**运行时不读**
- `$env/dynamic/public` — 运行时从 Cloudflare Pages 环境变量读取

`TOTP_SECRET` 是密钥，不能写进 `wrangler.toml` `[vars]`（明文），也不能用 `$env/static/public`（会 bake 进 bundle）。

正确做法：
1. `wrangler secret put PUBLIC_TOTP_SECRET` ← 注入运行时环境
2. 前端代码用 `$env/dynamic/public` ← 运行时读取，不 bake

`.env.production` 只用于本地 `bun run build` 时 bake `PUBLIC_WS_URL`，`TOTP_SECRET` 不需要放这里（因为已经用 dynamic env 了）。

---

## 常见问题

### Q: `PUBLIC_WS_URL` 填错了会怎样？

- dev：UI 连不上 worker → 价格不动
- prod：UI 连不上 worker → 白屏 / 无数据
- 改 `wrangler.toml` 后重新 `bun run deploy` 即可

### Q: OKX credentials missing

`packages/do-worker/.dev.vars` 里的 key/secret/passphrase 没填，或格式不对。
dev 阶段只影响 buy/sell 下单；`GET /state` 等只读接口不受影响。

### Q: Phase 2 切 Live

```bash
# 1. 申请 OKX Live API Key（单独一套，跟 Demo 不同）
cd packages/do-worker
wrangler secret put OKX_LIVE_API_KEY
wrangler secret put OKX_LIVE_API_SECRET
wrangler secret put OKX_LIVE_PASSPHRASE

# 2. 改 do-worker wrangler.toml vars
OKX_DEMO_MODE = "0"

# 3. 重部署
bun run deploy   # 在 do-worker 目录
```

真实盈亏从此时开始记录。

### Q: 部署后数据丢失？

DO (Durable Object) 状态存在 Cloudflare 边缘存储，重启不丢。
如果误操作 `/api/reset`，会清空 DO 内 portfolio，重新从 OKX 拉余额。

### Q: 本地 build 失败

```bash
# 检查 PUBLIC_WS_URL 是否在环境变量里
cd ~/projects/sol-dca-dashboard
PUBLIC_WS_URL=ws://localhost:8787/ws bun run build
```
