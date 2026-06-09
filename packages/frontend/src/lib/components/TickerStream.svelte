<script>
	import { onMount, onDestroy } from 'svelte';
	import { createDashboardStore } from '$lib/stores/dashboard.svelte.js';
	import TopBar from '$lib/components/TopBar.svelte';
	import PriceDisplay from '$lib/components/PriceDisplay.svelte';
	import Portfolio from '$lib/components/Portfolio.svelte';
	import Controls from '$lib/components/Controls.svelte';
	import HistorySection from '$lib/components/HistorySection.svelte';
	import ErrorBanner from '$lib/components/ErrorBanner.svelte';

	// +page.svelte can pass a pre-created store instance (preferred).
	// If not provided, fall back to creating one from SSR initial data.
	let { initial = {}, store: externalStore = null } = $props();

	// Use the external store if provided; otherwise create one from SSR data
	const store = externalStore ?? createDashboardStore(initial);

	// Local bindable refs for TopBar's TOTP modal (store owns showTotpModal/pendingMode)
	let showTotpModal = $state(false);
	let pendingMode = $state(null);

	// Proxy store getters into local reactive vars so child components get $derived updates
	let wsState = $derived(store.wsState);
	let okxWsState = $derived(store.okxWsState);
	let sabbath = $derived(store.sabbath);
	let paused = $derived(store.paused);
	let mode = $derived(store.mode);
	let reconnectAttempts = $derived(store.reconnectAttempts);
	let reconnectStopped = $derived(store.reconnectStopped);
	let lastTickerPrice = $derived(store.lastTickerPrice);
	let lastTickerAt = $derived(store.lastTickerAt);
	let portfolio = $derived(store.portfolio);
	let missingCredentials = $derived(store.missingCredentials);
	let lastError = $derived(store.lastError);
	let refreshing = $derived(store.refreshing);
	let historyEntries = $derived(store.historyEntries);
	let historyFilter = $state(store.historyFilter);
	let historyLoading = $derived(store.historyLoading);
	let filteredHistory = $derived(store.filteredHistory);
	let liveCurrentValue = $derived(store.liveCurrentValue);
	let liveUnrealizedPnL = $derived(store.liveUnrealizedPnL);
	let liveProfit = $derived(store.liveProfit);
	let liveProfitPct = $derived(store.liveProfitPct);
	let monthBudgetMax = $derived(store.monthBudgetMax);
	let needsInit = $derived(store.needsInit);
	let needsFirstBuy = $derived(store.needsFirstBuy);
	let suggestedFirstBuy = $derived(store.suggestedFirstBuy);
	let starting = $derived(store.starting);
	let firstBuying = $derived(store.firstBuying);
	let resetting = $derived(store.resetting);

	// Keep local historyFilter in sync when store resets
	$effect(() => {
		historyFilter = store.historyFilter;
	});

	// --- TOTP flow (TopBar opens modal; verify/cancel flow back here) ---
	function handleSwitchMode(target) {
		store.switchMode(target);
		if (target === 'live') {
			showTotpModal = true;
			pendingMode = 'live';
		}
	}

	function handleTotpVerify() {
		showTotpModal = false;
		pendingMode = null;
		store.confirmTotpAndSwitch('live');
	}

	function handleTotpCancel() {
		showTotpModal = false;
		pendingMode = null;
	}

	// Expose TotpModal visibility as a store state proxy
	$effect(() => {
		showTotpModal = store.showTotpModal;
	});

	onMount(() => {
		store.connect();
		store.loadHistory();
		store.startHeartbeat();
	});

	onDestroy(() => {
		store.cleanup();
	});
</script>

<div class="stream">
	<TopBar
		{wsState}
		{okxWsState}
		{sabbath}
		{paused}
		{mode}
		{reconnectAttempts}
		{reconnectStopped}
		onManualReconnect={store.manualReconnect}
		onSwitchMode={handleSwitchMode}
		bind:showTotpModal
		bind:pendingMode
	/>

	{#if missingCredentials.length > 0}
		<ErrorBanner type="warning" {missingCredentials} />
	{/if}

	{#if lastError}
		<ErrorBanner message={lastError} />
	{/if}

	<PriceDisplay {lastTickerPrice} {lastTickerAt} />

	{#if portfolio}
		<Portfolio
			{portfolio}
			{lastTickerPrice}
			{liveCurrentValue}
			{liveUnrealizedPnL}
			{liveProfit}
			{liveProfitPct}
			{monthBudgetMax}
			{refreshing}
			onRefreshBalance={store.refreshBalance}
		/>
	{/if}

	<Controls
		{paused}
		{missingCredentials}
		{needsInit}
		{needsFirstBuy}
		{suggestedFirstBuy}
		{starting}
		{firstBuying}
		{resetting}
		onStartDca={store.startDca}
		onDoFirstBuy={store.doFirstBuy}
		onDoReset={store.doReset}
		onSendControl={store.sendControl}
	/>

	<HistorySection
		{historyEntries}
		{historyFilter}
		{filteredHistory}
		{historyLoading}
		onLoadHistory={store.loadHistory}
		onSetFilter={(f) => { historyFilter = f; store.historyFilter = f; }}
	/>
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

	@media (max-width: 600px) {
		.stream {
			padding: 0.75rem;
		}
	}
</style>
