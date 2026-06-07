# SOL DCA Dashboard — 技术架构文档

## 1. 整体架构

### 三层结构

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              Browser (Chrome)                               │
│   SvelteKit SPA (Pages)  ←──── WS 实时推流 (直连 worker URL)              │
│   SSR 初始 state                                                              │
│   模式切换: localStorage + cookie (demo/live)                                │
└──────────────┬──────────────────────────────────────────────────────────────┘
               │  HTTP (service binding)
               │  WS (直连 wss://sol-dca-do-worker.<account>.workers.dev/ws?mode=)
               │  PUBLIC_WS_URL 环境变量注入
               ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                        Cloudflare Edge                                      │
│                                                                              │
│  ┌─────────────────────────────┐    ┌─────────────────────────────────────┐ │
│  │  Frontend: SvelteKit       │    │  do-worker: 独立 Worker               │ │
│  │  (Cloudflare Pages        │    │                                     │ │
│  │   + Pages Functions)       │    │  Durable Object: TickerHub          │ │
│  │                             │    │  ├─ OKX public WS (订阅 ticker)      │ │
│  │  Bindings:                 │    │  ├─ Browser WS (Hibernation API)    │ │
│  │  ├─ SOL_DCA_WORKER         │───────→│  ├─ Strategy engine (decide())    │ │
│  │  │   (service binding)     │    │  ├─ OKX private REST (下单/余额)    │ │
│  │                             │    │  └─ DO SQLite (唯一存储)            │ │
│  │  路由:                      │    │  两个独立 DO instance:              │ │
│  │  ├─ SSR / (首页)           │    │  ├─ sol-usdt-demo                   │ │
│  │  ├─ /api/state             │    │  └─ sol-usdt-live                   │ │
│  │  ├─ /api/control           │    │                                     │ │
│  │  ├─ /api/signals           │    │                                     │ │
│  │  ├─ /api/trades            │    │                                     │ │
│  │  └─ /api/reset             │    │  路由: /ws /state /control /reset   │ │
│  └─────────────────────────────┘    └─────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                              OKX Exchange                                    │
│                                                                              │
│  Public WS:  wss://ws.okx.com:8443/ws/v5/public  (ticker 订阅)             │
│  Private REST: https://www.okx.com/api/v5/...  (下单/查余额)                │
│                                                                              │
│  两套 credentials:                                                          │
│  ├─ Demo: OKX_DEMO_API_KEY / OKX_DEMO_API_SECRET / OKX_DEMO_PASSPHRASE    │
│  │        + x-simulated-trading: 1 header                                 │
│  └─ Live: OKX_LIVE_API_KEY / OKX_LIVE_API_SECRET / OKX_LIVE_PASSPHRASE   │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 数据流向

```
OKX Public WS (ticker)
       │
       ▼
TickerHub DO (onOkxTicker)
       │
       ├─ broadcastBrowser() ──→ Browser WS ──→ TickerStream.svelte (实时价格)
       │
       ▼
strategy.decide() ──→ buy/sell 决策
       │
       ├─ executeBuy() ──→ OKX Private REST (marketBuy)
       │                        │
       │                        ▼
        │                   OKX fill ──→ persistTrade() ──→ DO SQLite
        │
        ├─ executeSell() ──→ OKX Private REST (marketSell)
        │
        ▼
persistPortfolio() ──→ DO SQLite
persistSignal() ──→ DO SQLite
```

---

## 2. Frontend (`packages/frontend`)

### 2.1 技术栈

| 组件 | 技术 | 说明 |
|------|------|------|
| Framework | SvelteKit 2 + Svelte 5 runes | `$state`, `$derived`, `$props` |
| 运行时 | Cloudflare Pages + Pages Functions | SSR + API 路由 |
| Adapter | `@sveltejs/adapter-cloudflare` | 输出到 `.svelte-kit/cloudflare` |
| 构建 | Vite + `@cloudflare/vite-plugin` | Workers 兼容 |
| 部署 | `wrangler pages deploy` | Pages 项目 |

**文件**: `packages/frontend/svelte.config.js`

```javascript
const config = {
    compilerOptions: { runes: ({ filename }) => ... },
    kit: {
        adapter: adapter({ platformProxy: { remoteBindings: false } })
    }
};
```

### 2.2 Pages Function 的角色

Pages Function 处理所有 HTTP 路由，分为两类：

**SSR 路由** (`+page.server.js`):
- `GET /` — 调用 `SOL_DCA_WORKER.fetch('/state?mode=X')` 获取初始 portfolio，通过 service binding 直连 DO Worker，不走公网

**API 代理路由** (`+server.js`):
- `GET /api/state`, `POST /api/control`, `GET /api/signals`, `GET /api/trades`, `POST /api/reset`
- 全部透传给 `SOL_DCA_WORKER.fetch()`（service binding）

Pages Function **不** 处理 WebSocket — 浏览器直连 worker URL。

### 2.3 Service Binding 工作方式

**wrangler.toml** (`packages/frontend/wrangler.toml`):
```toml
[[services]]
binding = "SOL_DCA_WORKER"
service = "sol-dca-do-worker"
```

代码中调用：
```javascript
// packages/frontend/src/routes/+page.server.js
const res = await platform.env.SOL_DCA_WORKER.fetch(
    `https://do/state?mode=${mode}`,
    { method: 'GET' }
);
```

`SOL_DCA_WORKER` 是 service binding，在 Cloudflare 内部网络直连，不走公网，有极低延迟。

### 2.4 WebSocket 连接（浏览器直连 worker URL）

浏览器**不**通过 Pages Function 建立 WS，而是直连 worker URL：

```javascript
// packages/frontend/src/lib/config.js
import { PUBLIC_WS_URL } from '$env/static/public';
export const WS_URL = PUBLIC_WS_URL || 'ws://localhost:8787/ws';

// packages/frontend/src/lib/components/TickerStream.svelte
const url = `${WS_URL}${sep}mode=${mode}`;
ws = new WebSocket(url);
```

生产环境 `PUBLIC_WS_URL` = `wss://sol-dca-do-worker.<account>.workers.dev/ws`

为什么直连：
1. Cloudflare Pages Functions **不支持** WebSocket upgrade
2. DO Worker 是独立 worker，不受 Pages 平台限制
3. DO Hibernation API 需要直连

### 2.5 模式切换（demo / live）

- **存储**: `localStorage['sol-dca-mode']` + `cookie sol-dca-mode`
- **SSR 感知**: `+page.server.js` 读 cookie 决定拉哪个 DO
- **WS 重连**: 切换时关闭老 WS → 清空 buffer → 连接新 DO → fetch state → load history
- **隔离保证**: 两个独立 DO instance，数据完全物理隔离

```javascript
// packages/frontend/src/lib/components/TickerStream.svelte
async function switchMode(target) {
    if (target === 'live' && !confirm(...)) return;
    mode = target;
    localStorage.setItem('sol-dca-mode', target);
    document.cookie = `sol-dca-mode=${target}; path=/; max-age=31536000; SameSite=Lax`;
    // 关闭老 WS, 清空 buffer, 重连
    ws?.close();
    portfolio = null; recentSignals = []; recentTrades = [];
    connect();
    fetchState();
    loadHistory();
}
```

---

## 3. do-worker (`packages/do-worker`)

### 3.1 Durable Object (TickerHub) 的职责

`TickerHub` 是系统的核心状态机，单例（每个 mode 一个实例）。

**职责**:
1. 持有 OKX public WS 连接（订阅 SOL-USDT ticker）
2. 持有 N 个浏览器 WS 连接（Hibernation API，持久化）
3. ticker → 策略决策 → OKX private API 下单
4. 写 portfolio/signals/trades: DO SQLite（热，ms 级，唯一的持久化存储）
5. 报警（Feishu/Bark/通用 JSON，level-based rate limit）
6. 接收浏览器控制指令（pause / resume / init_dca / manual_sell）

**入口**: `packages/do-worker/src/index.js` 导出 `TickerHub` class，供 wrangler 识别。

### 3.2 DO 内置 SQLite（唯一存储）

DO 内置 SQLite 是唯一的持久化存储。

| 维度 | DO SQLite |
|------|-----------|
| 用途 | 实时读/写，毫秒级延迟 |
| 生命周期 | DO 迁移时保留（SQLite 文件随 DO 实例） |
| FIFO 限制 | signals 50 条 / trades 30 条 |
| 备份 | 由 Cloudflare DO 平台管理 |

**恢复流程**（`loadPortfolio`）：
```
1. DO SQLite 优先读
2. 空 → OKX 真实余额（syncBalanceFromOkx）
3. 失败 → 硬编码 7000 USDT
```

### 3.3 为什么用两个独立 DO instance 做 demo/live 隔离

```
index.js 路由逻辑:
  const hubName = mode === 'live' ? 'sol-usdt-live' : 'sol-usdt-demo';
  const stub = env.SOL_DCA_TICKER_HUB.get(
      env.SOL_DCA_TICKER_HUB.idFromName(hubName)
  );
```

- `idFromName()` 对同一个 name 返回同一个 DO instance
- `sol-usdt-demo` → demo DO，`sol-usdt-live` → live DO
- 两个 DO 有**独立**的：
  - OKX WS 连接
  - 浏览器 WS 连接池
  - OKX credentials（demo vs live API keys）
  - portfolio / signals / trades 数据
  - 心跳定时器

物理隔离的好处：
- demo 崩了不影响 live
- 可以同时连接两个 WS 看两套数据
- DO SQLite 用 `id=1`（demo）/ `id=2`（live）区分，不加 mode 列

---

## 4. OKX 集成

### 4.1 公共 WS（价格订阅）

**文件**: `packages/do-worker/src/okx/ws-public.js`

```javascript
// 连接 OKX public WS，订阅 SOL-USDT ticker
export function subscribeTicker(url, channel, instId, handlers) {
    const ws = new WebSocket(url);
    ws.addEventListener('open', () => {
        ws.send(JSON.stringify({
            op: 'subscribe',
            args: [{ channel: 'tickers', instId: 'SOL-USDT' }]
        }));
        // 25s ping 维持连接
        pingTimer = setInterval(() => ws.send('ping'), 25_000);
    });
    ws.addEventListener('message', (event) => {
        const msg = JSON.parse(event.data);
        if (msg.arg?.channel === 'tickers') {
            handlers.onTicker(msg.data[0]); // { last, open24h, high24h, low24h, ts }
        }
    });
}
```

OKX 要求 30s 内 ping，代码用 25s 间隔。

### 4.2 私有 REST API（下单/余额）

**文件**: `packages/do-worker/src/okx/client.js`

覆盖：
- `POST /api/v5/trade/order` — 市价买单/卖单
- `GET /api/v5/account/balance` — 查 USDT/SOL 余额
- `GET /api/v5/trade/order` — 查订单详情（拿真实 fill 数据）
- `GET /api/v5/market/ticker` — 公共行情（作为价格兜底）

HMAC-SHA256 签名，所有私有请求带 timestamp + signature。

### 4.3 Demo/Live 两套 credentials 隔离

```javascript
// packages/do-worker/src/okx/client.js
export function createOkxClient(env, forceMode) {
    const isDemo = forceMode != null ? forceMode : env.OKX_DEMO_MODE !== '0';
    const creds = isDemo
        ? { apiKey: env.OKX_DEMO_API_KEY, ... }
        : { apiKey: env.OKX_LIVE_API_KEY, ... };
    return new OkxClient({ ...creds, isDemo }, env.OKX_API_BASE);
}

// packages/do-worker/src/ticker-hub.js
this.okx = createOkxClient(env, this.isDemo);
```

OKX 模拟盘和实盘是**两套独立 API key**（同一账号下分别申请）。Demo 模式在请求头加 `x-simulated-trading: 1`。

凭证通过 `wrangler secret put` 注入：
```bash
wrangler secret put OKX_DEMO_API_KEY
wrangler secret put OKX_DEMO_API_SECRET
wrangler secret put OKX_DEMO_PASSPHRASE
wrangler secret put OKX_LIVE_API_KEY
...
```

---

## 5. 策略引擎

**文件**: `packages/do-worker/src/strategy.js`

### 5.1 策略参数（V6: `E_d5p_5x + r0.5_s0.3_n3`）

```javascript
export const STRATEGY_CONFIG = {
    id: 'E_d5p_5x_r0.5_s0.3_n3',
    baseAmount: 30,           // 首买 $30
    triggerPct: 5,            // 跌幅 ≥ 5% 触发
    monthLimit: 500,          // 月度上限 $500
    multiplierTiers: [
        { minDrop: 5,  multiplier: 1 },
        { minDrop: 10, multiplier: 2 },
        { minDrop: 20, multiplier: 3 },
        { minDrop: 30, multiplier: 4 },
        { minDrop: 50, multiplier: 5 }
    ],
    sellTriggerBase: 0.5,    // 分批回本: +50% / +100% / +150%
    sellPct: 0.3,            // 每档卖 30% 持仓
    stairCount: 3            // 3 档（累计卖 90%，留 10% 底仓）
};
```

### 5.2 决策流程（`decide()`）

```
每个 ticker 到达:
  │
  ├─ 1) 分批回本检查（先于 DCA）
  │     checkSellStairs():
  │       浮盈 = (现价 - avgBuyPrice) × solHolding
  │       任意 stairs[i].ratio 满足 → sell 30% sol
  │
  ├─ 2) DCA 冷启动守卫
  │     lastBuyPrice === null → hold（等用户点"启动 V6"）
  │
  ├─ 3) DCA 触发判断
  │     drawdownPct = (lastBuyPrice - 现价) / lastBuyPrice
  │     ≥ 5% → 计算加码倍数 → 月度上限检查
  │     余额不足 → hold
  │
  └─ 4) 返回 action: buy / sell / hold
```

**分批回本优先于 DCA 触发**：用户要求先卖回本，再考虑加码买。

### 5.3 月度上限、余额检查

```javascript
// 月度上限
const spent = state.monthSpent.get(todayMonthKey) || 0;
if (spent + buyAmount > cfg.monthLimit) {
    holdReason = `月度上限已满 (本月已用 $${spent.toFixed(0)} / $${cfg.monthLimit})`;
    buyAmount = 0;
}

// 余额检查
if (buyAmount > state.usdtBalance) {
    holdReason = `余额不足 (需 $${buyAmount.toFixed(0)} > 余额 $${state.usdtBalance.toFixed(2)})`;
    buyAmount = state.usdtBalance;
}
```

每月 1 日 00:00 UTC 重置（`maybeResetMonth()`）。

### 5.4 冷启动行为

```
状态: lastBuyPrice === null
行为: 不做任何 buy/sell，只 hold
原因: 等用户显式点击 UI"启动 V6"按钮
     → /control action=init_dca
     → 首买 $30，建立 avgBuyPrice
     → 之后 V6 自动监控
```

---

## 6. 数据库

### 6.1 DO 内置 SQLite 表结构

**文件**: `packages/do-worker/src/ticker-hub.js`（`SQL_SCHEMA` 常量）

DO 内置 SQLite 是唯一的持久化存储，包含以下表：

```sql
-- portfolio_state: 单行持仓（id=1 demo / id=2 live）
CREATE TABLE portfolio_state (
    id                      INTEGER PRIMARY KEY,  -- 1=demo, 2=live
    usdt_balance            REAL DEFAULT 0 NOT NULL,
    sol_holding             REAL DEFAULT 0 NOT NULL,
    avg_buy_price           REAL,
    last_buy_price          REAL,
    total_spent             REAL DEFAULT 0 NOT NULL,
    total_sold              REAL DEFAULT 0 NOT NULL,
    realized_pnl            REAL DEFAULT 0 NOT NULL,
    current_month_spent     REAL DEFAULT 0 NOT NULL,
    current_month_reset     TEXT,
    consecutive_dca_buys    INTEGER DEFAULT 0 NOT NULL,
    sell_stairs_triggered   TEXT DEFAULT '[]' NOT NULL,  -- JSON 数组 [0,1,2]
    updated_at              TEXT NOT NULL
);

-- signals: 策略决策日志
CREATE TABLE signals (
    id              TEXT PRIMARY KEY,
    price           REAL NOT NULL,
    action          TEXT NOT NULL,  -- buy/sell/hold/skip
    reason          TEXT NOT NULL,
    drawdown_pct    REAL,
    profit_pct      REAL,
    usdt_after      REAL,
    sol_after       REAL,
    mode            TEXT DEFAULT 'demo' NOT NULL,  -- demo/live label
    created_at      TEXT NOT NULL
);

-- trades: 成交记录
CREATE TABLE trades (
    id                      TEXT PRIMARY KEY,
    cl_ord_id               TEXT NOT NULL UNIQUE,  -- OKX client order ID
    side                    TEXT NOT NULL,  -- buy/sell
    price                   REAL NOT NULL,
    amount_usdt             REAL NOT NULL,
    amount_sol              REAL NOT NULL,
    reason                  TEXT NOT NULL,
    drawdown_pct            REAL,
    multiplier              REAL,
    profit_pct              REAL,
    mode                    TEXT DEFAULT 'demo' NOT NULL,
    okx_order_id            TEXT,
    okx_state               TEXT,
    okx_fee                 TEXT,           -- "0.001 SOL"
    intended_amount_usdt    REAL,           -- 下单意图 vs 实际成交
    created_at              TEXT NOT NULL
);

-- alert_cooldowns: 报警冷却（DO 重启后不丢失）
CREATE TABLE alert_cooldowns (
    key         TEXT PRIMARY KEY,
    last_sent   INTEGER NOT NULL
);
```

### 6.2 Schema 管理

- 唯一数据源：`SQL_SCHEMA`（`ticker-hub.js`）
- DO 构造函数执行 `applyMigrations()`：先 `DROP TABLE IF EXISTS`（destructive rebuild），再 `CREATE TABLE IF NOT EXISTS`
- 2026-06-07 决策：不保留历史 trades，schema drift 风险 > 数据价值

### 6.3 demo/live 隔离

用行 ID 物理隔离（不加 mode 列）：

| mode | portfolio_state.id | signals.mode | trades.mode |
|------|---------------------|--------------|-------------|
| demo | 1 | `'demo'` | `'demo'` |
| live | 2 | `'live'` | `'live'` |

```javascript
// packages/do-worker/src/ticker-hub.js
const portfolioRowId = this.mode === 'live' ? 2 : 1;
this.state.storage.sql.exec(
    'SELECT * FROM portfolio_state WHERE id = ?', portfolioRowId
);
```

---

## 7. 安息日保护

**文件**: `packages/do-worker/src/sabbath.js`

### 7.1 柏林 SDA 安息日判断逻辑

```javascript
export function isSabbath() {
    const now = new Date();
    const utcDay = now.getUTCDay();   // 0=Sun, 5=Fri, 6=Sat
    const utcHour = now.getUTCHours();

    // 周五 17:00 UTC 起
    if (utcDay === 5 && utcHour >= 17) return true;
    // 周六 17:00 UTC 止
    if (utcDay === 6 && utcHour < 17) return true;
    return false;
}
```

**简化假设**：
- 柏林（UTC+1/UTC+2）周五日落 ≈ 17:00 UTC
- 夏令时/冬令时差异忽略，保守覆盖

### 7.2 安息日时 DCA 决策如何处理

```javascript
// packages/do-worker/src/ticker-hub.js (onOkxTicker)
async onOkxTicker(d) {
    this.lastTickerPrice = parseFloat(d.last);
    this.broadcastBrowser({ type: 'ticker', price: this.lastTickerPrice, ... });

    if (this.isPaused) return;
    if (isSabbath()) return;  // ← 安息日直接跳过，不决策
    if (!this.portfolio) return;

    const decision = decide(...);
    // ...
}
```

效果：安息日内收到 ticker → 只广播价格，不触发 buy/sell，所有决策 hold。

前端也显示 Sabbath badge：
```svelte
{#if sabbath}
    <span class="badge warn">Sabbath (DCA off)</span>
{/if}
```

---

## 8. 报警系统

**文件**: `packages/do-worker/src/alert.js`

### 8.1 三种格式

| 类型 | 检测方式 | 格式 |
|------|---------|------|
| Feishu | URL host 含 `open.feishu.cn` 或 `larksuite` | `msg_type: interactive` card |
| Bark | URL host 含 `api.day.app` | GET `?title=...&body=...&level=...` |
| 通用 JSON | 其他所有 URL | `POST { title, body, level, ts }` |

```javascript
// packages/do-worker/src/alert.js
async function postFeishu(url, title, body, level) {
    return postJson(url, {
        msg_type: 'interactive',
        card: {
            header: { title: { tag: 'plain_text', content: title }, template: color },
            elements: [{ tag: 'div', text: { tag: 'plain_text', content: body } }]
        }
    });
}

async function postBark(url, title, body, level) {
    const u = new URL(url);
    u.searchParams.set('title', title);
    u.searchParams.set('body', body);
    u.searchParams.set('level', level);
    return fetch(u.toString(), { method: 'GET' });
}
```

### 8.2 Level-based Rate Limiting

| Level | 冷却窗口 | 用途 |
|-------|---------|------|
| info | 5 分钟 | OKX WS connected / BUY executed 等日常事件 |
| warn | 2 分钟 | Ticker silent 30s 等需关注事件 |
| error | 不限 | BUY failed / SELL failed 等紧急事件 |

冷却 key = `${level}:${title}`，例如 `info:OKX WS connected`。

### 8.3 Cooldown 持久化到 DO Storage SQLite

```javascript
// packages/do-worker/src/ticker-hub.js
sendAlertSafe(level, title, body) {
    const cooldownMs = { info: 5*60*1000, warn: 2*60*1000 }[level];
    if (cooldownMs) {
        const key = `${level}:${title}`;
        const row = this.state.storage.sql
            .exec('SELECT last_sent FROM alert_cooldowns WHERE key = ?', key)
            .toArray()[0];
        if (Date.now() - (row?.last_sent || 0) < cooldownMs) return;
        this.state.storage.sql.exec(
            'INSERT OR REPLACE INTO alert_cooldowns (key, last_sent) VALUES (?, ?)',
            key, Date.now()
        );
    }
    sendAlert(this.alertUrl, title, body, level).catch(console.error);
}
```

**为什么用 DO SQLite 而不是 in-memory Map**：
- DO 重启（包括版本更新、idle eviction）后 in-memory Map 会丢失
- DO SQLite 里的 `alert_cooldowns` 表在重启后仍然有效
- 冷却窗口跨 DO 生命周期持久

---

## 9. 部署模型

### 9.1 基础设施对照

| 组件 | 部署方式 | 配置 |
|------|---------|------|
| Frontend (SvelteKit) | `wrangler pages deploy .svelte-kit/cloudflare` | `packages/frontend/wrangler.toml` |
| do-worker (独立 Worker) | `wrangler deploy` | `packages/do-worker/wrangler.toml` |
| Durable Object | 随 do-worker 自动实例化 | `[[durable_objects.bindings]]` |

### 9.2 Pages Function（前端）

```
wrangler pages deploy .svelte-kit/cloudflare --project-name sol-dca-dashboard
```

Pages 项目绑定：
- `SOL_DCA_WORKER` — service binding → do-worker
- `PUBLIC_WS_URL` — 环境变量，浏览器 WS URL

### 9.3 独立 Worker（do-worker）

```
cd packages/do-worker && wrangler deploy
```

Worker 绑定：
- `SOL_DCA_TICKER_HUB` — Durable Object class `TickerHub`
- Secrets: `OKX_DEMO_API_KEY/SECRET/PASSPHRASE`, `OKX_LIVE_*`, `ALERT_WEBHOOK_URL`

### 9.4 wrangler secret 管理

```bash
# demo credentials
wrangler secret put OKX_DEMO_API_KEY
wrangler secret put OKX_DEMO_API_SECRET
wrangler secret put OKX_DEMO_PASSPHRASE

# live credentials
wrangler secret put OKX_LIVE_API_KEY
wrangler secret put OKX_LIVE_API_SECRET
wrangler secret put OKX_LIVE_PASSPHRASE

# 可选：报警 webhook
wrangler secret put ALERT_WEBHOOK_URL
```

Phase 1（Demo）只需 demo credentials；Phase 2（Live）加 live credentials + `OKX_DEMO_MODE=0`。

---

## 10. 关键设计决策记录

### 10.1 为什么用 Durable Object 而不是纯 KV

| 维度 | Durable Object | KV |
|------|---------------|-----|
| 状态一致性 | 单写者，WS 连接和状态在同一实例 | 多写者，需额外同步 |
| WebSocket | 原生支持 Hibernation API | 不支持 |
| 存储 | 内置 SQLite（结构化） | KV（键值，序列化） |
| 实时性 | 内存直读，ms 级 | 可能 eventual consistency |
| 适用场景 | 策略状态机 + WS 连接 | 简单配置/缓存 |

本系统需要：
- OKX WS 和 N 个浏览器 WS **同时**持有在一个实例里
- 策略状态（portfolio、sellStairsTriggered Set）需要事务性读写
- 高频 ticker 推送（10 次/秒）需要 ms 级存储

纯 KV 无法满足，DO 是唯一选择。

### 10.2 为什么 WS 直连 worker 不走 Pages

**Cloudflare Pages Functions 不支持 WebSocket upgrade**。

Pages Functions 是 request/response 模型，没有持久连接能力。而：
- DO Hibernation API 需要直连 worker URL
- 浏览器 WS 需要 ws/wss 协议
- Worker URL 格式：`wss://sol-dca-do-worker.<account>.workers.dev/ws?mode=demo`

Pages Function 只做 HTTP API 代理（`/api/state` 等），WS 流量全部直连 worker。

### 10.3 为什么用 service binding

```
Browser  ──HTTP──→  Pages Function  ──service binding──→  DO Worker
                   (SSR + API 代理)         (Cloudflare 内部网络，极低延迟)
```

Service binding 的优势：
- 零公网延迟，Cloudflare 内部网络直连
- 不需要暴露 worker 公网 HTTP 路由（WS 路由仍需暴露）
- Pages Function 可以调用 DO 的 `/state` 等 HTTP 路由
- 认证由 Cloudflare 平台处理，无需 API key

Service binding 等效于一个 Cloudflare 内部 HTTP 客户端。

---

## 附录：文件索引

| 文件路径 | 职责 |
|---------|------|
| `packages/do-worker/src/index.js` | Worker 入口，路由 `/ws /state /control /reset`，导出 `TickerHub` |
| `packages/do-worker/src/ticker-hub.js` | Durable Object TickerHub 全实现（WS、策略、存储、报警） |
| `packages/do-worker/src/strategy.js` | V6 策略 `decide()` + `applyBuy/applySell` |
| `packages/do-worker/src/okx/client.js` | OKX V5 REST 客户端（HMAC 签名） |
| `packages/do-worker/src/okx/ws-public.js` | OKX 公共 WS 订阅 ticker |
| `packages/do-worker/src/alert.js` | Feishu/Bark/通用 JSON 报警 + rate limit |
| `packages/do-worker/src/sabbath.js` | 柏林 SDA 安息日判断 |
| `packages/do-worker/wrangler.toml` | do-worker 部署配置 |
| `packages/frontend/src/routes/+page.svelte` | 根页面，渲染 `TickerStream` |
| `packages/frontend/src/routes/+page.server.js` | SSR load，通过 service binding 拿初始 state |
| `packages/frontend/src/lib/components/TickerStream.svelte` | 主 UI 组件（1262 行） |
| `packages/frontend/src/routes/api/state/+server.js` | GET /api/state 代理 |
| `packages/frontend/src/routes/api/control/+server.js` | POST /api/control 代理 |
| `packages/frontend/src/routes/api/signals/+server.js` | GET /api/signals（service binding → DO） |
| `packages/frontend/src/routes/api/trades/+server.js` | GET /api/trades（service binding → DO） |
| `packages/frontend/src/routes/api/reset/+server.js` | POST /api/reset 代理 |
| `packages/frontend/src/lib/config.js` | WS_URL 环境变量注入 |
| `packages/frontend/wrangler.toml` | Frontend Pages 部署配置 |
| `packages/frontend/svelte.config.js` | SvelteKit + Cloudflare adapter 配置 |

---

## 附录：SvelteKit + Cloudflare Pages 环境变量教训（2026-06-07）

### `$env/static/public` vs `$env/dynamic/public`

| 类型 | 读取时机 | 读取来源 | 适用场景 |
|------|---------|---------|---------|
| `$env/static/public` | **build 时** bake 进 JS bundle | `.env` / `.env.production` 等 dotenv 文件 | build 时必须确定的值（PUBLIC_WS_URL） |
| `$env/dynamic/public` | **运行时**（每次访问） | Cloudflare Pages 环境变量（`wrangler secret put` / Pages Dashboard） | 密钥、不可 bake 的值 |

**踩坑记录**：
- `PUBLIC_WS_URL`：需要 build 时确定 → 用 `$env/static/public`，在 `.env.production` 里写值
- `PUBLIC_TOTP_SECRET`：是密钥不能用 `[vars]` 明文放 + 需要运行时注入 → 用 `$env/dynamic/public`，通过 `wrangler secret put` 注入

### Cloudflare Pages 的 env 文件分层

| 文件 | 谁读 | 用途 |
|------|------|------|
| `.env` | `vite dev`（SvelteKit dev server） | 本地 vite 开发 |
| `.env.production` | `vite build`（build 时） | 本地 prod build 时 bake 进 bundle |
| `.dev.vars` | `wrangler dev`（Cloudflare Workers dev） | Cloudflare Workers 本地开发 |
| `wrangler.toml [vars]` | **运行时**，但仅限 Workers（DO/Worker） | Cloudflare Workers 运行时注入 |
| `wrangler secret put` | **运行时**（Pages + Workers） | 密钥类值，**不进 bundle** |

**注意**：`vite dev` **不读** `.dev.vars`（那是 wrangler 专用的）；`.env.production` **不读** `.dev.vars`。各走各的。
