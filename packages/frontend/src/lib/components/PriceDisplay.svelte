<script>
	import { formatTime, formatAge } from '$lib/utils/format.js';

	let { lastTickerPrice = 0, lastTickerAt = 0 } = $props();

	let tickerAgeSec = $derived(
		lastTickerAt ? Math.max(0, Math.floor((Date.now() - lastTickerAt) / 1000)) : -1
	);
	let tickerTimeText = $derived(lastTickerAt ? formatTime(lastTickerAt) : '');
</script>

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

<style>
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

	@media (max-width: 600px) {
		.price {
			padding: 1.25rem 0;
		}
		.price .value {
			font-size: 2.25rem;
		}
	}
</style>
