<script>
	let {
		historyEntries = [],
		historyFilter = 'all',
		filteredHistory = [],
		historyLoading = false,
		onLoadHistory,
		onSetFilter
	} = $props();

	/** @param {string} filter */
	function setFilter(filter) {
		onSetFilter?.(filter);
	}
</script>

<section class="history">
	<div class="history-header">
		<h2>📊 完整历史</h2>
		<button
			class="history-refresh"
			onclick={onLoadHistory}
			disabled={historyLoading}
			title="从 server (D1) 重新拉全量"
		>
			{historyLoading ? '⏳' : '🔄'}
		</button>
	</div>

	<div class="history-toolbar">
		<button class:active={historyFilter === 'all'} onclick={() => setFilter('all')}>
			全部
		</button>
		<button class:active={historyFilter === 'signal'} onclick={() => setFilter('signal')}>
			仅决策
		</button>
		<button class:active={historyFilter === 'trade'} onclick={() => setFilter('trade')}>
			仅成交
		</button>
		<button class:active={historyFilter === 'hold'} onclick={() => setFilter('hold')}>
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
			{#if historyFilter === 'hold'}暂无 hold 信号 (V6 跌幅未到 5% — 等行情)
			{:else if historyFilter === 'trade'}暂无成交记录
			{:else}暂无历史记录 — 等待 ticker 推送{/if}
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
									{e.side === 'buy'
										? `$${e.amount_usdt?.toFixed(2)}`
										: `${e.amount_sol?.toFixed(4)} SOL`}
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

<style>
	.history {
		margin-top: 1.5rem;
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
		font-size: 1.1rem;
		margin: 0 0 0.5rem 0;
		color: #aaa;
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

	@media (max-width: 600px) {
		.history-toolbar button {
			padding: 0.4rem 0.6rem;
			font-size: 0.75rem;
		}
		.history-scroll {
			max-height: 360px;
		}
	}
</style>
