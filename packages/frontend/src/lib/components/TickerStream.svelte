<script>
	import { onMount, onDestroy } from 'svelte';
	import { WS_URL } from '$lib/config.js';

	let { initial = {} } = $props();

	// === Realtime state (Svelte 5 runes) ===
	let portfolio = $state(initial.portfolio ?? null);
	let paused = $state(initial.paused ?? false);
	let okxWsState = $state(initial.okxWsState ?? 'init');
	let lastTickerPrice = $state(initial.lastTickerPrice ?? 0);
	let lastTickerAt = $state(initial.lastTickerAt ?? 0);
	let missingCredentials = $state(initial.missingCredentials ?? []);
	let sabbath = $state(initial.sabbath ?? false);
	let connected = $state(false);
	let wsState = $state('connecting'); // connecting | open | closed | error
	let recentSignals = $state([]);
	let recentTrades = $state([]);
	let lastError = $state(null);

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

	let ws = null;
	let reconnectTimer = null;

	function connect() {
		if (typeof window === 'undefined') return;
		// WS URL 走 env 注入 (PUBLIC_WS_URL):
		//   dev:  ws://localhost:8787/ws
		//   prod: wss://sol-dca-do-worker.<sub>.workers.dev/ws
		const url = WS_URL;
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
				missingCredentials = msg.missingCredentials ?? [];
				break;
			case 'ticker':
				lastTickerPrice = msg.price;
				if (msg.ts) lastTickerAt = msg.ts;
				break;
			case 'signal':
				recentSignals = [msg, ...recentSignals].slice(0, 50);
				break;
			case 'trade':
				recentTrades = [msg, ...recentTrades].slice(0, 30);
				break;
			case 'paused':
				paused = msg.paused;
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

	// === Controls ===
	async function sendControl(action, extra = {}) {
		const res = await fetch('/api/control', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ action, ...extra })
		});
		if (!res.ok) {
			lastError = `control ${action} failed: ${res.status}`;
		}
		return res.json();
	}
</script>

<div class="stream">
	<header>
		<h1>SOL DCA Dashboard</h1>
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
				<span class="badge warn">Paused</span>
			{/if}
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
				<div class="label">USDT</div>
				<div class="value">${portfolio.usdtBalance.toFixed(2)}</div>
			</div>
			<div class="card">
				<div class="label">SOL 持仓</div>
				<div class="value">{portfolio.solHolding.toFixed(4)}</div>
			</div>
			<div class="card">
				<div class="label">总价值</div>
				<div class="value">${(portfolio.currentValue ?? 0).toFixed(2)}</div>
			</div>
			<div class="card" class:profit={(portfolio.profit ?? 0) >= 0} class:loss={(portfolio.profit ?? 0) < 0}>
				<div class="label">盈亏</div>
				<div class="value">
					${(portfolio.profit ?? 0).toFixed(2)}
					<span class="pct">({(portfolio.profitPct ?? 0).toFixed(2)}%)</span>
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
		</section>
	{/if}

	<section class="controls">
		{#if needsInit && missingCredentials.length === 0}
			<button class="init" onclick={() => sendControl('init_dca')}>
				🚀 Start DCA(首买 $30)
			</button>
		{/if}
		{#if paused}
			<button onclick={() => sendControl('resume')}>▶ Resume</button>
		{:else}
			<button onclick={() => sendControl('pause')}>⏸ Pause</button>
		{/if}
		<button onclick={async () => {
			const sol = portfolio?.solHolding ?? 0;
			const half = sol / 2;
			if (half > 0.001) await sendControl('manual_sell', { amountSol: half });
		}} disabled={!portfolio || portfolio.solHolding < 0.002 || missingCredentials.length > 0}>
			💸 卖一半 ({((portfolio?.solHolding ?? 0) / 2).toFixed(4)} SOL)
		</button>
	</section>

	<section class="signals">
		<h2>
			决策日志
			{#if holdCount > 0}
				<span class="folded">({holdCount} 个 hold 已折叠)</span>
			{/if}
		</h2>
		{#if recentSignals.length === 0}
			<div class="empty">暂无信号 — 等待 ticker 推送</div>
		{:else if visibleSignals.length === 0}
			<div class="empty">最近 {holdCount} 条全是 hold(无买入/卖出触发,5% 跌幅未到)</div>
		{:else}
			<table>
				<thead>
					<tr>
						<th>时间</th>
						<th>价格</th>
						<th>动作</th>
						<th>原因</th>
					</tr>
				</thead>
				<tbody>
					{#each visibleSignals.slice(0, 15) as s (s.id)}
						<tr>
							<td class="ts">{new Date(s.created_at).toLocaleTimeString()}</td>
							<td>${s.price.toFixed(2)}</td>
							<td class:buy={s.action === 'buy'} class:sell={s.action === 'sell'}>
								{s.action}
							</td>
							<td class="reason">{s.reason}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		{/if}
	</section>

	{#if recentTrades.length > 0}
		<section class="trades">
			<h2>最近成交</h2>
			<ul>
				{#each recentTrades.slice(0, 5) as t, i (i)}
					<li>
						<span class:buy={t.side === 'buy'} class:sell={t.side === 'sell'}>
							{t.side.toUpperCase()}
						</span>
						{t.side === 'buy' ? `$${t.amountUsdt.toFixed(2)}` : `${t.amountSol.toFixed(4)} SOL`}
						@ ${t.price.toFixed(2)} — {t.reason}
					</li>
				{/each}
			</ul>
		</section>
	{/if}
</div>

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
	.folded {
		font-size: 0.75rem;
		color: #666;
		font-weight: normal;
		margin-left: 0.5rem;
		font-family: ui-monospace, monospace;
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
	.controls {
		display: flex;
		gap: 0.5rem;
		margin: 1.5rem 0;
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
	.signals,
	.trades {
		margin-top: 1.5rem;
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
	td.hold,
	span.buy,
	span.sell {
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
	ul {
		list-style: none;
		padding: 0;
		margin: 0;
	}
	li {
		padding: 0.5rem;
		border-bottom: 1px solid #222;
		font-size: 0.875rem;
	}
</style>
