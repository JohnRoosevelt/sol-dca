<script>
	let {
		paused = false,
		missingCredentials = [],
		needsInit = false,
		needsFirstBuy = false,
		suggestedFirstBuy = 0,
		starting = false,
		firstBuying = false,
		resetting = false,
		onStartDca,
		onDoFirstBuy,
		onDoReset,
		onSendControl
	} = $props();
</script>

<section class="controls">
	{#if needsInit && missingCredentials.length === 0}
		<button
			class="init"
			onclick={onStartDca}
			disabled={starting || missingCredentials.length > 0}
			class:loading={starting}
			title="建一个 DCA round (写 dca_rounds + 设 isStarted=true), 不自动买 — 首买点下一个按钮"
		>
			{starting ? '⏳ 启动中(建 round…)' : '🚀 启动 V6(建 round)'}
		</button>
	{:else if needsFirstBuy && missingCredentials.length === 0}
		<button
			class="first-buy"
			onclick={onDoFirstBuy}
			disabled={firstBuying || missingCredentials.length > 0 || suggestedFirstBuy < 5}
			class:loading={firstBuying}
			title="首买 = 5% × 当前 USDT 余额 (PR5 supplyRates.base=0.05, minBuyAbsolute=$5 兜底). 显式 manual_buy, 走 backend computeBuyAmount 算实际金额"
		>
			{firstBuying ? '⏳ 首买中…' : `🎯 首买 $${suggestedFirstBuy.toFixed(0)} (5% × 余额)`}
		</button>
	{:else if !needsInit && !needsFirstBuy}
		<button
			class="pause-toggle"
			class:is-paused={paused}
			onclick={() => onSendControl?.(paused ? 'resume' : 'pause')}
			title={paused ? 'V6 监控已暂停, 不响应 ticker' : 'V6 监控活跃, 跌 5% 触发加码 (PR4 disable sell staircase)'}
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
		onclick={onDoReset}
		disabled={resetting || missingCredentials.length > 0}
		class:loading={resetting}
		title="清空所有历史, 重新从 OKX 拉真实 USDT 余额, V6 监控从零开始"
	>
		{resetting ? '⏳ Reset 中(卖光 + 清空…)' : '🗑 Reset(卖光 + 清空)'}
	</button>

	<p class="control-hint">
		{#if needsInit}
			👆 启动 V6 建 round (写 dca_rounds + 设 isStarted=true, 不首买), 然后单独点 [首买] 5% × 余额建基准价. 之后 V6 自动监控跌 5% 加码
		{:else if needsFirstBuy}
			👆 Round 已建. 点 [首买] 5% × 余额建基准价. 想自定义金额走 console / feishu
		{:else if paused}
			V6 暂停中, 不响应 ticker。点"启动"恢复自动监控
		{:else}
			V6 活跃中, 自动监控跌 5% 加码 (PR4 disable sell staircase). 安息日自动暂停
		{/if}
	</p>
</section>

<style>
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

	@media (max-width: 600px) {
		.controls {
			gap: 0.5rem;
		}
		.controls button {
			flex: 1 1 calc(50% - 0.25rem);
			min-height: 44px;
			padding: 0.65rem 0.9rem;
		}
	}
</style>
