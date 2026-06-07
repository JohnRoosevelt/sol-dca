<script>
	import { onMount, onDestroy } from 'svelte';
	import { WS_URL, TOTP_SECRET } from '$lib/config.js';
	import TOTPModal from '$lib/components/TOTPModal.svelte';

	// +page.svelte 把 SSR data 包成 initial prop 传过来
	let { initial = {} } = $props();

	// === Mode: demo / live 物理隔离 (DO instance 各一份) ===
	//   优先级: localStorage > SSR 传的 initial.mode > 兜底 demo
	const VALID_MODES = ['demo', 'live'];
	function loadMode() {
		if (typeof window !== 'undefined') {
			const ls = localStorage.getItem('sol-dca-mode');
			if (VALID_MODES.includes(ls)) return ls;
		}
		if (VALID_MODES.includes(initial.mode)) return initial.mode;
		return 'demo';
	}
	/* svelte-ignore state_referenced_locally */
	let mode = $state(loadMode());

	// === Realtime state (Svelte 5 runes) ===
	// 注: initial prop 只在组件 mount 时读一次, 之后改 initial 不会自动更新
	// (WS hello 消息会在 onMount 后立即推送, 所以实际 portfolio 不会卡在 SSR 时的快照)
	/* svelte-ignore state_referenced_locally */
	let portfolio = $state(initial.portfolio ?? null);
	/* svelte-ignore state_referenced_locally */
	let paused = $state(initial.paused ?? false);
	/* svelte-ignore state_referenced_locally */
	let okxWsState = $state(initial.okxWsState ?? 'init');
	/* svelte-ignore state_referenced_locally */
	let lastTickerPrice = $state(initial.lastTickerPrice ?? 0);
	/* svelte-ignore state_referenced_locally */
	let lastTickerAt = $state(initial.lastTickerAt ?? 0);
	/* svelte-ignore state_referenced_locally */
	let missingCredentials = $state(initial.missingCredentials ?? []);
	/* svelte-ignore state_referenced_locally */
	let sabbath = $state(initial.sabbath ?? false);
	let connected = $state(false);
	let wsState = $state('connecting'); // connecting | open | closed | error
	let recentSignals = $state([]);
	let recentTrades = $state([]);
	let lastError = $state(null);

	// 按钮 loading 状态 — 防止 user 重复点击 + 让 user 知道过程没走完
	let starting = $state(false);   // 启动 V6 (init_dca) 中
	let resetting = $state(false);  // Reset (卖光 + 清空) 中
	let refreshing = $state(false); // 手动刷新余额中 — 独立状态, 跟 Start/Reset 隔开
	let controlInFlight = $derived(starting || resetting);
	let showTotpModal = $state(false);
	let pendingMode = $state(null);

	// === 30 分钟免重输 TOTP ===
	const TOTP_VERIFIED_KEY = 'sol-dca-totp-verified-at';
	const GRACE_MS = 30 * 60 * 1000; // 30 分钟

	/** 读 localStorage 时间戳, 判断是否在 30 分钟窗口内 */
	function isWithinGrace() {
		if (typeof window === 'undefined') return false;
		const raw = localStorage.getItem(TOTP_VERIFIED_KEY);
		if (!raw) return false;
		const ts = Number(raw);
		if (!Number.isFinite(ts)) return false;
		return Date.now() - ts < GRACE_MS;
	}

	/** 写时间戳 (验证成功后调用) */
	function markTotpVerified() {
		if (typeof window !== 'undefined') {
			localStorage.setItem(TOTP_VERIFIED_KEY, String(Date.now()));
		}
	}

	function confirmTotpAndSwitch() {
		showTotpModal = false;
		const target = pendingMode || 'live';
		pendingMode = null;
		// 验证成功 → 写时间戳 (Cancel/错误不写)
		markTotpVerified();
		if (target !== 'live') return;
		performModeSwitch(target);
	}
	// 派生:是否已初始化 DCA(决定 Start DCA 按钮是否显示)
	let needsInit = $derived(portfolio != null && portfolio.lastBuyPrice == null);

	// 决策日志:hold 折叠掉(避免误读"每秒钟都买入")
	let visibleSignals = $derived(recentSignals.filter((s) => s.action !== 'hold'));
	let holdCount = $derived(recentSignals.length - visibleSignals.length);

	// 价格更新时间戳格式化
	let tickerTimeText = $derived(
		lastTickerAt ? new Date(lastTickerAt).toLocaleTimeString() : ''
	);
	let tickerAgeSec = $derived(
		lastTickerAt ? Math.max(0, Math.floor((Date.now() - lastTickerAt) / 1000)) : -1
	);

	// === 实时 P&L 派生 (跟着 lastTickerPrice 走) ===
	//   server snapshot 里的 profit/currentValue/unrealizedPnL 只在 hello / portfolio_synced / reset / /state 时算
	//   ticker 推送只更新 lastTickerPrice, 不重算 profit → 之前 盈亏 数字僵住
	//   改法: 前端用 $derived 实时算, 跟 ticker 同步, server 不必每 tick 推
	let liveCurrentValue = $derived.by(() => {
		if (!portfolio) return 0;
		return portfolio.usdtBalance + (portfolio.solHolding ?? 0) * lastTickerPrice;
	});
	let liveUnrealizedPnL = $derived.by(() => {
		if (!portfolio || portfolio.avgBuyPrice == null || (portfolio.solHolding ?? 0) <= 0.0001) return 0;
		return (lastTickerPrice - portfolio.avgBuyPrice) * portfolio.solHolding;
	});
	let liveProfit = $derived.by(() => {
		if (!portfolio) return 0;
		return liveUnrealizedPnL + (portfolio.realizedPnL ?? 0);
	});
	let liveProfitPct = $derived.by(() => {
		if (
			!portfolio ||
			portfolio.avgBuyPrice == null ||
			portfolio.avgBuyPrice <= 0 ||
			(portfolio.solHolding ?? 0) <= 0.0001
		)
			return 0;
		return ((lastTickerPrice - portfolio.avgBuyPrice) / portfolio.avgBuyPrice) * 100;
	});

	// === 完整历史 (决策 + 成交 合并) ===
	//   - /api/signals + /api/trades 拉全量 (200/100), 跟 server 端 D1 同步
	//   - WS push 的 signal/trade 实时 prepend
	//   - 跟 live 决策日志/最近成交 隔开, 那个是"当前状态", 这个是"全量历史"
	let historyEntries = $state([]); // [{ ...signal, _type:'signal', _key }, { ...trade, _type:'trade', _key }]
	let historyFilter = $state('all'); // all | signal | trade | hold
	let historyLoading = $state(false);
	const HISTORY_LIMIT = 200; // UI 显示上限
	let filteredHistory = $derived.by(() => {
		if (historyFilter === 'all') return historyEntries;
		if (historyFilter === 'signal') return historyEntries.filter((e) => e._type === 'signal' && e.action !== 'hold');
		if (historyFilter === 'trade') return historyEntries.filter((e) => e._type === 'trade');
		if (historyFilter === 'hold') return historyEntries.filter((e) => e._type === 'signal' && e.action === 'hold');
		return historyEntries;
	});

	let ws = null;
	let reconnectTimer = null;

	function connect() {
		if (typeof window === 'undefined') return;
		// WS URL 走 env 注入 (PUBLIC_WS_URL) + 当前 mode:
		//   dev:  ws://localhost:8787/ws?mode=demo
		//   prod: wss://sol-dca-do-worker.<sub>.workers.dev/ws?mode=demo
		const sep = WS_URL.includes('?') ? '&' : '?';
		const url = `${WS_URL}${sep}mode=${mode}`;
		wsState = 'connecting';
		ws = new WebSocket(url);

		ws.onopen = () => {
			wsState = 'open';
			connected = true;
		};

		ws.onmessage = (e) => {
			try {
				const msg = JSON.parse(e.data);
				handle(msg);
			} catch (err) {
				console.error('[TickerStream] parse failed:', err);
			}
		};

		ws.onerror = () => {
			wsState = 'error';
			lastError = 'WebSocket error';
		};

		ws.onclose = () => {
			wsState = 'closed';
			connected = false;
			// 自动重连
			if (reconnectTimer) clearTimeout(reconnectTimer);
			reconnectTimer = setTimeout(connect, 3000);
		};
	}

	function handle(msg) {
		switch (msg.type) {
			case 'hello':
				portfolio = msg.portfolio;
				paused = msg.paused;
				okxWsState = msg.okxWsState;
				lastTickerPrice = msg.lastTickerPrice;
				lastTickerAt = msg.lastTickerAt ?? 0;
				// hello 消息也带 recentSignals / recentTrades (跟 /state 对齐),
				// 避免页面刷新 / 重连时决策日志 + 最近成交被清空
				if (Array.isArray(msg.recentSignals)) recentSignals = msg.recentSignals;
				if (Array.isArray(msg.recentTrades)) recentTrades = msg.recentTrades;
				missingCredentials = msg.missingCredentials ?? [];
				break;
			case 'ticker':
				lastTickerPrice = msg.price;
				if (msg.ts) lastTickerAt = msg.ts;
				break;
			case 'signal':
				// slice 跟 hello 消息 (ticker-hub.js) 一致 — 都是 50 条
				recentSignals = [msg, ...recentSignals].slice(0, 50);
				// 同步进 完整历史
				historyEntries = [
					{ ...msg, _type: 'signal', _key: 's_' + (msg.id || Date.now() + '_' + Math.random()) },
					...historyEntries
				].slice(0, HISTORY_LIMIT);
				break;
			case 'trade':
				// slice 跟 hello 消息 (ticker-hub.js) 一致 — 都是 50 条
				recentTrades = [msg, ...recentTrades].slice(0, 50);
				// 同步进 完整历史
				historyEntries = [
					{
						...msg,
						_type: 'trade',
						_key: 't_' + (msg.id || Date.now() + '_' + Math.random()),
						created_at: msg.created_at ?? new Date().toISOString()
					},
					...historyEntries
				].slice(0, HISTORY_LIMIT);
				break;
			case 'paused':
				paused = msg.paused;
				break;
			case 'portfolio_synced':
				if (msg.portfolio) portfolio = msg.portfolio;
				break;
			case 'portfolio_reset':
				// /api/reset 后清空历史 + 拉新 OKX 余额, 整个 portfolio 被替换
				portfolio = msg.portfolio;
				recentSignals = [];
				recentTrades = [];
				break;
			case 'error':
				lastError = msg.message;
				break;
		}
	}

	// 简单心跳（30s）— DO 会自动回 pong
	let heartbeatTimer;
	onMount(() => {
		connect();
		// 拉完整历史 (决策 + 成交), 跟 hello 消息互补 (hello 是 DO 内存 50 条, 这个是 D1 全量 200/100)
		loadHistory();
		heartbeatTimer = setInterval(() => {
			if (ws?.readyState === WebSocket.OPEN) {
				ws.send(JSON.stringify({ type: 'ping' }));
			}
		}, 30000);
	});

	onDestroy(() => {
		if (heartbeatTimer) clearInterval(heartbeatTimer);
		if (reconnectTimer) clearTimeout(reconnectTimer);
		if (ws) {
			ws.onclose = null; // 防止触发重连
			ws.close();
		}
	});

	// === Mode switch (demo <-> live) ===
	//   切到 live 时需要 TOTP 验证 (会动真钱)
	//   切完: 关闭老 WS, 重新连接新 mode 的 DO, 清空前端 buffer, 重拉 state
	function switchMode(target) {
		if (!VALID_MODES.includes(target)) return;
		if (target === mode) return;
		if (target === 'live') {
			const secret = TOTP_SECRET;
			if (secret && isWithinGrace()) {
				// 30 分钟窗口内, 直接切换不弹 modal
				pendingMode = null;
				performModeSwitch(target);
				return;
			}
			if (!secret) {
				console.warn('[switchMode] TOTP_SECRET not configured, skipping 2FA');
			}
			pendingMode = 'live';
			showTotpModal = true;
			return;
		}
		performModeSwitch(target);
	}

	/** 执行 mode 切换 (公共逻辑, 供 switchMode demo 路径和 confirmTotpAndSwitch live 路径共用) */
	function performModeSwitch(target) {
		mode = target;
		if (typeof window !== 'undefined') {
			localStorage.setItem('sol-dca-mode', target);
			document.cookie = `sol-dca-mode=${target}; path=/; max-age=31536000; SameSite=Lax`;
		}
		if (ws) {
			ws.onclose = null;
			try { ws.close(); } catch (_) {}
			ws = null;
		}
		portfolio = null;
		paused = false;
		okxWsState = 'init';
		lastTickerPrice = 0;
		lastTickerAt = 0;
		recentSignals = [];
		recentTrades = [];
		historyEntries = [];
		historyFilter = 'all';
		lastError = null;
		connect();
		fetchState();
		loadHistory();
	}

	async function fetchState() {
		try {
			const res = await fetch(`/api/sync-balance?mode=${mode}`);
			if (!res.ok) {
				lastError = `state ${mode} failed: ${res.status}`;
				return;
			}
			const d = await res.json();
			portfolio = d.portfolio;
			paused = d.paused ?? false;
			okxWsState = d.okxWsState ?? 'init';
			lastTickerPrice = d.lastTickerPrice ?? 0;
			lastTickerAt = d.lastTickerAt ?? 0;
			missingCredentials = d.missingCredentials ?? [];
			// 同步后端真实最近 signals + trades (跟 WS 累积双轨制)
			// - WS 推的 signal/trade 实时累积
			// - fetchState 兜底: 任何 race / 重连 / refresh 时, 跟后端 DO storage 对齐
			if (Array.isArray(d.recentSignals)) recentSignals = d.recentSignals;
			if (Array.isArray(d.recentTrades)) recentTrades = d.recentTrades;
		} catch (err) {
			lastError = `state fetch: ${err}`;
		}
	}

	// === Controls ===
	async function sendControl(action, extra = {}) {
		const res = await fetch(`/api/control?mode=${mode}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ action, ...extra })
		});
		if (!res.ok) {
			lastError = `control ${action} failed: ${res.status}`;
		}
		return res.json();
	}

	// === Refresh balance (USDT + SOL) ===
	//   独立 loading state, 跟 Start/Reset 隔开
	//   第一次 fetch 立刻拉; 2s 后再 fetch 一次, 应对后端 syncBalanceFromOkx 的时差
	async function refreshBalance() {
		if (refreshing) return;
		refreshing = true;
		try {
			await fetchState();
			await new Promise((r) => setTimeout(r, 2000));
			if (refreshing) {
				await fetchState();
			}
		} finally {
			refreshing = false;
		}
	}

	// === Start V6 (init_dca) — 包装 loading + 卖/买完 fetch ===
	async function startDca() {
		if (starting || missingCredentials.length > 0) return;
		starting = true;
		try {
			await sendControl('init_dca');
			// 后端 executeBuy 完成会 broadcast trade + portfolio_synced
			// 兜底: 等响应后再 fetch 一次, 拿到 sync 后的 portfolio
			await fetchState();
		} catch (err) {
			lastError = `start failed: ${err}`;
		} finally {
			starting = false;
		}
	}

	// === Reset — 包装 loading + fetch ===
	async function doReset() {
		if (resetting || missingCredentials.length > 0) return;
		if (
			!confirm(
				'确认清空 + 卖光所有 SOL?\n\n' +
					'- 尝试卖光持仓 SOL 换 USDT (OKX 失败也强制清空 portfolio)\n' +
					'- 清空所有 trades / signals / 历史\n' +
					'- 重新拉 OKX 真实账户 USDT 余额\n' +
					'- V6 监控从零开始 (需重新点"启动 V6"建基准价)'
			)
		)
			return;
		resetting = true;
		try {
			const res = await fetch(`/api/reset?mode=${mode}`, { method: 'POST' });
			if (!res.ok) {
				lastError = `reset failed: ${res.status}`;
				return;
			}
			const data = await res.json();
			// /reset 响应自带 portfolio (来自 broadcast 同一份 snapshot)
			if (data?.portfolio) {
				portfolio = data.portfolio;
			} else {
				await fetchState();
			}
		} catch (err) {
			lastError = `reset error: ${err}`;
		} finally {
			resetting = false;
		}
	}

	// === 拉完整历史 (决策 + 成交 合并) ===
	//   /api/signals + /api/trades 走 SvelteKit proxy → worker DO 内存 / D1
	//   dev 走 service binding (worker 内存 50 条), prod 走 D1 (200/100 上限)
	//   返回结构差异 (snake_case vs camelCase) 已在 proxy 端统一 — signal: id/price/action/reason/drawdown_pct/...
	//                                                              trade: id/side/price/amount_usdt/amount_sol/reason/...
	async function loadHistory() {
		historyLoading = true;
		try {
			const [sRes, tRes] = await Promise.all([
				fetch(`/api/signals?mode=${mode}&limit=200`),
				fetch(`/api/trades?mode=${mode}&limit=100`)
			]);
			const sData = sRes.ok ? await sRes.json() : { signals: [] };
			const tData = tRes.ok ? await tRes.json() : { trades: [] };
			// 统一字段格式 (signal 用 snake_case, trade 也用 snake_case) — UI 渲染时映射
			const sEntries = (sData.signals || []).map((s) => ({
				_type: 'signal',
				_key: 's_' + s.id,
				created_at: s.created_at,
				action: s.action,
				price: s.price,
				reason: s.reason,
				drawdown_pct: s.drawdown_pct,
				profit_pct: s.profit_pct
			}));
			const tEntries = (tData.trades || []).map((t) => ({
				_type: 'trade',
				_key: 't_' + t.id,
				created_at: t.created_at,
				action: t.side, // trade 用 side, 渲染时统一看 action
				side: t.side,
				price: t.price,
				amount_usdt: t.amount_usdt,
				amount_sol: t.amount_sol,
				reason: t.reason
			}));
			historyEntries = [...sEntries, ...tEntries]
				.sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
				.slice(0, HISTORY_LIMIT);
		} catch (err) {
			console.error('loadHistory failed:', err);
		} finally {
			historyLoading = false;
		}
	}
</script>

<div class="stream">
	<header class="topbar">
		<div class="brand">
<div class="logo" aria-label="OWL" role="img" />

			<h1>SOL DCA Dashboard</h1>
		</div>
		<div class="topbar-right">
			<div class="status">
				<span class="badge" class:ok={wsState === 'open'} class:warn={wsState === 'connecting'} class:err={wsState === 'closed' || wsState === 'error'}>
					{wsState}
				</span>
				<span class="badge" class:ok={okxWsState === 'open'} class:err={okxWsState !== 'open'}>
					OKX: {okxWsState}
				</span>
				{#if sabbath}
					<span class="badge warn">Sabbath (DCA off)</span>
				{/if}
				{#if paused}
					<span class="badge warn">V6 监控: 暂停</span>
				{/if}
			</div>
			<div class="mode-toggle" role="group" aria-label="选择交易模式">
				<button
					class="mode-btn"
					class:active={mode === 'demo'}
					onclick={() => switchMode('demo')}
					title="模拟盘, 不动真钱"
				>
					🎮 Demo
				</button>
				<button
					class="mode-btn danger"
					class:active={mode === 'live'}
					onclick={() => switchMode('live')}
					title="⚠️ 真实账户, 所有 buy/sell 动真钱 (TOTP 2FA 保护)"
				>
					💰 Live
				</button>
			</div>
		</div>
	</header>

	{#if missingCredentials.length > 0}
		<div class="error credentials-missing">
			<strong>OKX credentials missing:</strong>
			{`{`}{missingCredentials.join(', ')}{`}`}
			<br />
			<small>put via <code>wrangler secret put &lt;KEY&gt;</code> (remote) or write to <code>do-worker/.dev.vars</code> (local). See <code>do-worker/wrangler.toml</code> for required keys.</small>
		</div>
	{/if}

	{#if lastError}
		<div class="error">{lastError}</div>
	{/if}

	<section class="price">
		<div class="label">
			SOL/USDT
			{#if lastTickerAt}
				<span class="ts-meta">· 更新于 {tickerTimeText} ({tickerAgeSec}s 前)</span>
			{:else}
				<span class="ts-meta">· 等待 ticker</span>
			{/if}
		</div>
		<div class="value">${lastTickerPrice.toFixed(2)}</div>
	</section>

	{#if portfolio}
		<section class="portfolio">
			<div class="card">
				<div class="card-header">
					<div class="label">USDT</div>
					<button
						class="refresh-btn"
						onclick={refreshBalance}
						disabled={refreshing}
						title="重新从 OKX 拉 USDT + SOL 余额(2s 后自动再拉一次)"
						aria-label="刷新余额"
					>
						{refreshing ? '⏳' : '🔄'}
					</button>
				</div>
				<div class="value">${portfolio.usdtBalance.toFixed(2)}</div>
			</div>
			<div class="card">
				<div class="card-header">
					<div class="label">SOL 持仓</div>
					<button
						class="refresh-btn"
						onclick={refreshBalance}
						disabled={refreshing}
						title="重新从 OKX 拉 USDT + SOL 余额(2s 后自动再拉一次)"
						aria-label="刷新余额"
					>
						{refreshing ? '⏳' : '🔄'}
					</button>
				</div>
				<div class="value">{(Math.floor(portfolio.solHolding * 1000) / 1000).toFixed(3)}</div>
			</div>
			<div class="card">
				<div class="label">总价值</div>
				<div class="value">${liveCurrentValue.toFixed(2)}</div>
			</div>
			<div class="card" class:profit={liveProfit >= 0} class:loss={liveProfit < 0}>
				<div class="label">
					盈亏
					{#if lastTickerPrice > 0}
						<span class="live-dot" title="实时跟 ticker 更新">●</span>
					{/if}
				</div>
				<div class="value">
					${liveProfit.toFixed(2)}
					<span class="pct">({liveProfitPct.toFixed(2)}%)</span>
				</div>
			</div>
			<div class="card">
				<div class="label">本月已用</div>
				<div class="value">${(portfolio.monthSpentThisMonth ?? 0).toFixed(0)} / $500</div>
			</div>
			<div class="card">
				<div class="label">最近买入</div>
				<div class="value">${(portfolio.lastBuyPrice ?? 0).toFixed(2)}</div>
			</div>
			<div class="card">
				<div class="label">平均买入</div>
				<div class="value">${portfolio.avgBuyPrice != null ? portfolio.avgBuyPrice.toFixed(2) : '—'}</div>
			</div>
		</section>
		<section class="pnl-breakdown">
			<span class="breakdown-item" class:pos={liveUnrealizedPnL > 0} class:neg={liveUnrealizedPnL < 0}>
				持仓浮盈: ${liveUnrealizedPnL.toFixed(2)}
			</span>
			<span class="sep">·</span>
			<span class="breakdown-item" class:pos={(portfolio.realizedPnL ?? 0) > 0} class:neg={(portfolio.realizedPnL ?? 0) < 0}>
				已实现: ${(portfolio.realizedPnL ?? 0).toFixed(2)}
			</span>
			<span class="sep">·</span>
			<span class="breakdown-item hint">
				公式: (现价 − avg) × 持仓数 + 累计已实现
			</span>
		</section>
	{/if}

	<section class="controls">
		{#if needsInit && missingCredentials.length === 0}
			<button
				class="init"
				onclick={startDca}
				disabled={starting || missingCredentials.length > 0}
				class:loading={starting}
			>
				{starting ? '⏳ 启动中(首买 $30…)' : '🚀 启动 V6(首买 $30 建基准价)'}
			</button>
		{:else if !needsInit}
			<button
				class="pause-toggle"
				class:is-paused={paused}
				onclick={() => sendControl(paused ? 'resume' : 'pause')}
				title={paused ? 'V6 监控已暂停, 不响应 ticker' : 'V6 监控活跃, 跌 5% 触发加码 / 涨 50% 触发分批回本'}
			>
				{#if paused}
					▶ 启动 V6 监控
				{:else}
					⏸ 暂停 V6 监控
				{/if}
			</button>
		{/if}
		<button
			class="reset"
			onclick={doReset}
			disabled={resetting || missingCredentials.length > 0}
			class:loading={resetting}
			title="清空所有历史, 重新从 OKX 拉真实 USDT 余额, V6 监控从零开始"
		>
			{resetting ? '⏳ Reset 中(卖光 + 清空…)' : '🗑 Reset(卖光 + 清空)'}
		</button>
		<p class="control-hint">
			{#if needsInit}
				👆 启动 V6 会在 OKX 下 $30 市价买单建基准价, 之后 V6 自动监控跌 5% 加码 / 涨 50% 分批回本
			{:else if paused}
				V6 暂停中, 不响应 ticker。点"启动"恢复自动监控
			{:else}
				V6 活跃中, 自动监控跌幅 / 涨幅, 触发后自动 buy/sell。安息日自动暂停
			{/if}
		</p>
	</section>

	<!-- 完整历史: 决策 + 成交 合并 (唯一的"历史" view, 替代了之前的"决策日志 / 最近成交"两块)
	     WS push 的 signal/trade 会实时 prepend, 不需要手动刷新 -->
	<section class="history">
		<div class="history-header">
			<h2>📊 完整历史</h2>
			<button
				class="history-refresh"
				onclick={loadHistory}
				disabled={historyLoading}
				title="从 server (D1) 重新拉全量"
			>
				{historyLoading ? '⏳' : '🔄'}
			</button>
		</div>
		<div class="history-toolbar">
			<button
				class:active={historyFilter === 'all'}
				onclick={() => (historyFilter = 'all')}
			>
				全部
			</button>
			<button
				class:active={historyFilter === 'signal'}
				onclick={() => (historyFilter = 'signal')}
			>
				仅决策
			</button>
			<button
				class:active={historyFilter === 'trade'}
				onclick={() => (historyFilter = 'trade')}
			>
				仅成交
			</button>
			<button
				class:active={historyFilter === 'hold'}
				onclick={() => (historyFilter = 'hold')}
			>
				仅 hold
			</button>
			<span class="count">
				{filteredHistory.length} 条
				{#if historyEntries.length > filteredHistory.length}
					/ 共 {historyEntries.length}
				{/if}
			</span>
		</div>
		{#if historyLoading && historyEntries.length === 0}
			<div class="empty">加载中…</div>
		{:else if filteredHistory.length === 0}
			<div class="empty">
				{#if historyFilter === 'hold'}暂无 hold 信号 (V6 跌幅未到 5% — 等行情){:else if historyFilter === 'trade'}暂无成交记录{:else}暂无历史记录 — 等待 ticker 推送{/if}
			</div>
		{:else}
			<div class="history-scroll">
				<table>
					<thead>
						<tr>
							<th>时间</th>
							<th>类型</th>
							<th>动作</th>
							<th>价格</th>
							<th>数量</th>
							<th>原因</th>
						</tr>
					</thead>
					<tbody>
						{#each filteredHistory as e (e._key)}
							<tr>
								<td class="ts">{new Date(e.created_at).toLocaleString()}</td>
								<td class="kind">{e._type === 'signal' ? '决策' : '成交'}</td>
								<td
									class:buy={e.action === 'buy' || e.side === 'buy'}
									class:sell={e.action === 'sell' || e.side === 'sell'}
									class:hold={e.action === 'hold'}
								>
									{e.action}
								</td>
								<td>${e.price?.toFixed(2) ?? '—'}</td>
								<td>
									{#if e._type === 'trade'}
										{e.side === 'buy' ? `$${e.amount_usdt?.toFixed(2)}` : `${e.amount_sol?.toFixed(4)} SOL`}
									{:else}
										—
									{/if}
								</td>
								<td class="reason">{e.reason}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
			<div class="history-end">
				— 已显示全部 {filteredHistory.length} 条
				{#if historyEntries.length > filteredHistory.length}
					/ 共 {historyEntries.length}
				{/if}
				(信号 + 成交) —
			</div>
		{/if}
	</section>
</div>

<TOTPModal bind:open={showTotpModal} onVerify={confirmTotpAndSwitch} onCancel={() => (pendingMode = null)} />

<style>
	.stream {
		max-width: 960px;
		margin: 0 auto;
		padding: 1.5rem;
		font-family: ui-sans-serif, system-ui, -apple-system, sans-serif;
		color: #e7e9ea;
		background: #0a0a0a;
		min-height: 100vh;
	}
	header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		margin-bottom: 1.5rem;
		flex-wrap: wrap;
		gap: 0.75rem;
	}
	h1 {
		margin: 0;
		font-size: 1.5rem;
	}
	h2 {
		font-size: 1.1rem;
		margin: 0 0 0.5rem 0;
		color: #aaa;
	}

	/* === 完整历史 === */
	.history {
		margin-top: 1.5rem;
		/* 页面底部留白, 让 history section 不贴边, 给"加载完成"呼吸空间 */
		margin-bottom: 3rem;
		padding-bottom: 1rem;
	}
	.history-end {
		text-align: center;
		padding: 0.85rem 0 0.5rem;
		font-size: 0.75rem;
		color: #555;
		font-family: ui-monospace, monospace;
		letter-spacing: 0.05em;
		/* 上分割线提示"列表结束" */
		border-top: 1px dashed #2a2a2a;
		margin-top: 0.5rem;
	}
	.history-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
		margin-bottom: 0.5rem;
	}
	.history-header h2 {
		margin: 0;
	}
	.history-refresh {
		background: transparent;
		color: #aaa;
		border: 1px solid #333;
		padding: 0.3rem 0.5rem;
		font-size: 0.85rem;
		border-radius: 4px;
		cursor: pointer;
		line-height: 1;
	}
	.history-refresh:hover:not(:disabled) {
		border-color: #4ade80;
		color: #4ade80;
	}
	.history-refresh:disabled {
		opacity: 0.5;
		cursor: wait;
	}
	.history-toolbar {
		display: flex;
		gap: 0.4rem;
		align-items: center;
		margin-bottom: 0.5rem;
		flex-wrap: wrap;
	}
	.history-toolbar button {
		background: #1c1c1c;
		color: #ccc;
		border: 1px solid #333;
		padding: 0.3rem 0.7rem;
		font-size: 0.8rem;
		border-radius: 4px;
		cursor: pointer;
	}
	.history-toolbar button:hover:not(.active) {
		border-color: #555;
	}
	.history-toolbar button.active {
		background: #2563eb;
		color: #fff;
		border-color: #2563eb;
	}
	.history-toolbar .count {
		margin-left: auto;
		font-size: 0.75rem;
		color: #666;
		font-family: ui-monospace, monospace;
	}
	.history-scroll {
		max-height: 480px;
		overflow-y: auto;
		border: 1px solid #222;
		border-radius: 4px;
	}
	.history-scroll table {
		font-size: 0.8rem;
	}
	.history-scroll th,
	.history-scroll td {
		padding: 0.4rem 0.6rem;
	}
	.history-scroll td.kind {
		color: #888;
		font-size: 0.75rem;
		text-transform: uppercase;
		letter-spacing: 0.05em;
	}
	.status {
		display: flex;
		gap: 0.5rem;
	}
	.badge {
		padding: 0.25rem 0.5rem;
		border-radius: 4px;
		font-size: 0.75rem;
		background: #333;
		color: #ccc;
		font-family: ui-monospace, monospace;
	}
	.badge.ok {
		background: #16a34a;
		color: #fff;
	}
	.badge.warn {
		background: #ca8a04;
		color: #fff;
	}
	.badge.err {
		background: #dc2626;
		color: #fff;
	}
	.error {
		background: #7f1d1d;
		color: #fee2e2;
		padding: 0.75rem;
		border-radius: 4px;
		margin-bottom: 1rem;
	}
	.credentials-missing {
		background: #7f1d1d;
		border: 2px solid #dc2626;
	}
	.credentials-missing code {
		background: #1c1c1c;
		padding: 0.1rem 0.4rem;
		border-radius: 3px;
		font-size: 0.85em;
	}
	.credentials-missing small {
		display: block;
		margin-top: 0.5rem;
		color: #fca5a5;
	}
	.price {
		text-align: center;
		padding: 2rem 0;
		border-bottom: 1px solid #222;
	}
	.price .label {
		color: #888;
		font-size: 0.875rem;
	}
	.ts-meta {
		font-size: 0.75rem;
		color: #666;
		font-family: ui-monospace, monospace;
		margin-left: 0.25rem;
	}
	.price .value {
		font-size: 3rem;
		font-weight: bold;
		font-family: ui-monospace, monospace;
		margin-top: 0.5rem;
	}
	.portfolio {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
		gap: 0.75rem;
		margin: 1.5rem 0;
	}
	.card {
		background: #18181b;
		padding: 1rem;
		border-radius: 6px;
		border: 1px solid #27272a;
	}
	.card .label {
		color: #888;
		font-size: 0.75rem;
		text-transform: uppercase;
		letter-spacing: 0.05em;
	}
	.card .value {
		font-size: 1.25rem;
		font-weight: 600;
		font-family: ui-monospace, monospace;
		margin-top: 0.25rem;
	}

	.card-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
	}
	.refresh-btn {
		background: transparent;
		border: 1px solid #333;
		border-radius: 4px;
		padding: 0.15rem 0.4rem;
		font-size: 0.85rem;
		cursor: pointer;
		color: #aaa;
		line-height: 1;
		transition: all 0.15s;
	}
	.refresh-btn:hover:not(:disabled) {
		border-color: #4ade80;
		color: #4ade80;
	}
	.refresh-btn:disabled {
		cursor: wait;
		opacity: 0.5;
	}
	.card.profit .value {
		color: #4ade80;
	}
	.card.loss .value {
		color: #f87171;
	}
	.pct {
		font-size: 0.875rem;
		color: inherit;
		opacity: 0.8;
	}
	.pnl-breakdown {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem 0.75rem;
		font-size: 0.875rem;
		color: rgba(255, 255, 255, 0.7);
		padding: 0 0.25rem 0.5rem;
	}
	.pnl-breakdown .breakdown-item.pos {
		color: #4ade80;
	}
	.pnl-breakdown .breakdown-item.neg {
		color: #f87171;
	}
	.pnl-breakdown .breakdown-item.hint {
		color: rgba(255, 255, 255, 0.45);
		font-size: 0.75rem;
	}
	.pnl-breakdown .sep {
		opacity: 0.4;
	}

	/* === 顶部 topbar (Logo + 标题 + 状态徽章 + 模式切换 一行) === */
	.topbar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		margin-bottom: 1.5rem;
		flex-wrap: wrap;
	}
	.brand {
		display: flex;
		align-items: center;
		gap: 0.6rem;
	}
	.brand h1 {
		margin: 0;
		font-size: 1.25rem;
		font-weight: 600;
	}
.logo {
			width: 24px;
			height: 24px;
			background-color: currentColor;
			mask-image: url('/logo.svg');
			mask-size: contain;
			mask-repeat: no-repeat;
			mask-position: center;
		}
	.topbar-right {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		flex-wrap: wrap;
	}
	/* Demo / Live 模式切换 — pill 风格, 覆盖全局 button 样式 */
	.mode-toggle {
		display: flex;
		gap: 0;
		background: #18181b;
		border: 1px solid #27272a;
		border-radius: 8px;
		padding: 2px;
	}
	.mode-toggle .mode-btn {
		background: transparent !important;
		color: rgba(255, 255, 255, 0.55) !important;
		border: none !important;
		padding: 0.3rem 0.7rem;
		font-size: 0.8rem;
		border-radius: 6px;
		cursor: pointer;
		transition: all 0.15s;
		line-height: 1.2;
	}
	.mode-toggle .mode-btn:hover:not(:disabled):not(.active) {
		color: rgba(255, 255, 255, 0.85) !important;
	}
	.mode-toggle .mode-btn.active {
		background: #2563eb !important;
		color: white !important;
	}
	.mode-toggle .mode-btn.danger.active {
		background: #dc2626 !important;
	}
	.controls {
		display: flex;
		gap: 0.5rem;
		margin: 1.5rem 0;
		flex-wrap: wrap;
		align-items: center;
	}
	.controls p.control-hint {
		flex: 1 1 100%;
		margin: 0.5rem 0 0;
		font-size: 0.8rem;
		color: #6b7280;
		line-height: 1.4;
	}
	button {
		background: #2563eb;
		color: white;
		border: none;
		padding: 0.5rem 1rem;
		border-radius: 4px;
		cursor: pointer;
		font-size: 0.875rem;
	}
	button:hover:not(:disabled) {
		background: #1d4ed8;
	}
	button:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}
	button.loading {
		opacity: 0.7;
		cursor: wait;
		animation: pulse 1.2s ease-in-out infinite;
	}
	@keyframes pulse {
		0%, 100% { opacity: 0.7; }
		50% { opacity: 0.4; }
	}
	button.pause-toggle {
		background: #f59e0b;
	}
	button.pause-toggle:hover:not(:disabled) {
		background: #d97706;
	}
	button.pause-toggle.is-paused {
		background: #10b981;
	}
	button.pause-toggle.is-paused:hover:not(:disabled) {
		background: #059669;
	}
	button.reset {
		background: #dc2626;
	}
	button.reset:hover:not(:disabled) {
		background: #b91c1c;
	}
	table {
		width: 100%;
		border-collapse: collapse;
		font-size: 0.875rem;
	}
	th,
	td {
		text-align: left;
		padding: 0.5rem;
		border-bottom: 1px solid #222;
	}
	th {
		color: #888;
		font-weight: normal;
	}
	td.ts {
		font-family: ui-monospace, monospace;
		color: #888;
	}
	td.reason {
		color: #ccc;
	}
	td.buy,
	td.sell,
	td.hold {
		font-weight: bold;
		text-transform: uppercase;
	}
	.buy {
		color: #4ade80;
	}
	.sell {
		color: #f87171;
	}
	.hold {
		color: #888;
	}
	.empty {
		color: #666;
		font-style: italic;
		padding: 1rem;
	}
	.live-dot {
		color: #4ade80;
		font-size: 0.5rem;
		vertical-align: middle;
		margin-left: 0.3rem;
		animation: live-pulse 1.6s ease-in-out infinite;
	}
	@keyframes live-pulse {
		0%, 100% { opacity: 1; }
		50% { opacity: 0.35; }
	}

	/* === Mobile-first (<= 600px) ===
	 * 默认样式桌面, 窄屏覆盖:
	 *   - 单列 portfolio (桌面是 auto-fit grid)
	 *   - mode banner 垂直堆叠
	 *   - signals table → 横向滚动 (避免列挤压)
	 *   - 触摸目标 ≥ 44px (按钮 / refresh)
	 *   - 价格字号缩到 2.25rem
	 */
	@media (max-width: 600px) {
		.stream {
			padding: 0.75rem;
		}
		header {
			flex-direction: column;
			align-items: flex-start;
			gap: 0.5rem;
			margin-bottom: 1rem;
		}
		h1 {
			font-size: 1.25rem;
		}
		.price {
			padding: 1.25rem 0;
		}
		.price .value {
			font-size: 2.25rem;
		}
		.portfolio {
			grid-template-columns: 1fr;
			gap: 0.5rem;
		}
		.card {
			padding: 0.85rem 0.9rem;
		}
		.card .value {
			font-size: 1.1rem;
		}
		.refresh-btn {
			min-width: 44px;
			min-height: 44px;
			padding: 0.3rem 0.6rem;
			font-size: 1rem;
		}
		/* 窄屏: topbar 让 logo/标题一行, status+mode 另一行; flex-wrap 自动换 */
		.topbar {
			gap: 0.5rem;
			margin-bottom: 1rem;
		}
		.brand h1 {
			font-size: 1.1rem;
		}
.logo {
		width: 28px;
		height: 28px;
		background-color: currentColor;
		mask-image: url('/logo.svg');
		mask-size: contain;
		mask-repeat: no-repeat;
		mask-position: center;
		flex-shrink: 0;
	}
		.topbar-right {
			gap: 0.5rem;
		}
		.mode-toggle .mode-btn {
			padding: 0.35rem 0.6rem;
			font-size: 0.75rem;
		}
		.controls {
			gap: 0.5rem;
		}
		.controls button {
			flex: 1 1 calc(50% - 0.25rem);
			min-height: 44px;
			padding: 0.65rem 0.9rem;
		}
		.pnl-breakdown {
			font-size: 0.8rem;
		}
		.pnl-breakdown .breakdown-item.hint {
			display: none;
		}
		.history-toolbar button {
			padding: 0.4rem 0.6rem;
			font-size: 0.75rem;
		}
		.history-scroll {
			max-height: 360px;
		}
	}
</style>
