<script>
	import { formatPrice } from '$lib/utils/format.js';

	let {
		portfolio,
		lastTickerPrice = 0,
		liveCurrentValue = 0,
		liveUnrealizedPnL = 0,
		liveProfit = 0,
		liveProfitPct = 0,
		monthBudgetMax = 0,
		refreshing = false,
		onRefreshBalance
	} = $props();
</script>

<section class="portfolio">
	<div class="card">
		<div class="card-header">
			<div class="label">USDT</div>
			<button
				class="refresh-btn"
				onclick={onRefreshBalance}
				disabled={refreshing}
				title="重新从 OKX 拉 USDT + SOL 余额(2s 后自动再拉一次)"
				aria-label="刷新余额"
			>
				{refreshing ? '⏳' : '🔄'}
			</button>
		</div>
		<div class="value">${portfolio?.usdtBalance?.toFixed(2) ?? '—'}</div>
	</div>

	<div class="card">
		<div class="card-header">
			<div class="label">SOL 持仓</div>
			<button
				class="refresh-btn"
				onclick={onRefreshBalance}
				disabled={refreshing}
				title="重新从 OKX 拉 USDT + SOL 余额(2s 后自动再拉一次)"
				aria-label="刷新余额"
			>
				{refreshing ? '⏳' : '🔄'}
			</button>
		</div>
		<div class="value">{(Math.floor((portfolio?.solHolding ?? 0) * 1000) / 1000).toFixed(3)}</div>
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
		<div class="value">
			${(portfolio?.monthSpentThisMonth ?? 0).toFixed(0)} / ${monthBudgetMax.toFixed(0)}
		</div>
	</div>

	<div class="card">
		<div class="label">最近买入</div>
		<div class="value">${(portfolio?.lastBuyPrice ?? 0).toFixed(2)}</div>
	</div>

	<div class="card">
		<div class="label">平均买入</div>
		<div class="value">
			{portfolio?.avgBuyPrice != null ? `$${portfolio.avgBuyPrice.toFixed(2)}` : '—'}
		</div>
	</div>
</section>

<section class="pnl-breakdown">
	<span class="breakdown-item" class:pos={liveUnrealizedPnL > 0} class:neg={liveUnrealizedPnL < 0}>
		持仓浮盈: ${liveUnrealizedPnL.toFixed(2)}
	</span>
	<span class="sep">·</span>
	<span
		class="breakdown-item"
		class:pos={(portfolio?.realizedPnL ?? 0) > 0}
		class:neg={(portfolio?.realizedPnL ?? 0) < 0}
	>
		已实现: ${(portfolio?.realizedPnL ?? 0).toFixed(2)}
	</span>
	<span class="sep">·</span>
	<span class="breakdown-item hint">
		公式: (现价 − avg) × 持仓数 + 累计已实现
	</span>
</section>

<style>
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

	@media (max-width: 600px) {
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
		.pnl-breakdown {
			font-size: 0.8rem;
		}
		.pnl-breakdown .breakdown-item.hint {
			display: none;
		}
	}
</style>
