<script>
	import TOTPModal from '$lib/components/TOTPModal.svelte';

	let {
		wsState,
		okxWsState,
		sabbath,
		paused,
		mode,
		reconnectAttempts,
		reconnectStopped,
		onManualReconnect,
		onSwitchMode,
		showTotpModal = $bindable(false),
		pendingMode = $bindable(null)
	} = $props();

	function handleTotpVerify() {
		showTotpModal = false;
		pendingMode = null;
		onSwitchMode?.('live');
	}

	function handleTotpCancel() {
		showTotpModal = false;
		pendingMode = null;
	}
</script>

<header class="topbar">
	<div class="brand">
		<i class="logo" aria-label="OWL" role="img"></i>
		<h1>SOL DCA Dashboard</h1>
	</div>
	<div class="topbar-right">
		<div class="status">
			<span
				class="badge"
				class:ok={wsState === 'open'}
				class:warn={wsState === 'connecting'}
				class:err={wsState === 'closed' || wsState === 'error'}
			>
				{wsState}{reconnectAttempts > 0 && !reconnectStopped ? ` (${reconnectAttempts})` : ''}
			</span>
			{#if reconnectStopped}
				<button
					class="ws-retry-btn"
					onclick={onManualReconnect}
					title="WS 熔断后手动恢复 (8 次连续失败后停止自动重连, 避免 DO quota 雪崩)"
				>
					↻ 重连
				</button>
			{/if}
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
				onclick={() => onSwitchMode?.('demo')}
				title="模拟盘, 不动真钱"
			>
				🎮 Demo
			</button>
			<button
				class="mode-btn danger"
				class:active={mode === 'live'}
				onclick={() => onSwitchMode?.('live')}
				title="⚠️ 真实账户, 所有 buy/sell 动真钱 (TOTP 2FA 保护)"
			>
				💰 Live
			</button>
		</div>
	</div>
</header>

<TOTPModal
	bind:open={showTotpModal}
	onVerify={handleTotpVerify}
	onCancel={handleTotpCancel}
/>

<style>
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
		flex-shrink: 0;
	}
	.topbar-right {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		flex-wrap: wrap;
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
	.ws-retry-btn {
		background: #dc2626;
		color: #fff;
		border: 1px solid #fca5a5;
		padding: 0.2rem 0.5rem;
		font-size: 0.7rem;
		border-radius: 4px;
		cursor: pointer;
		line-height: 1;
		font-family: ui-monospace, monospace;
	}
	.ws-retry-btn:hover {
		background: #b91c1c;
		border-color: #fff;
	}
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

	@media (max-width: 600px) {
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
	}
</style>
