<script>
	import TickerStream from '$lib/components/TickerStream.svelte';
	import { createDashboardStore } from '$lib/stores/dashboard.svelte.js';

	let { data } = $props();

	// Wrap in $derived so all data.* reads are captured in a single reactive
	// evaluation (avoids state_referenced_locally warnings for each field).
	// The data object itself is SSR-loaded and immutable; only its initial
	// values are needed to seed the store.
	const dashboard = $derived(createDashboardStore({
		portfolio: data.portfolio,
		paused: data.paused,
		okxWsState: data.okxWsState,
		lastTickerPrice: data.lastTickerPrice,
		lastTickerAt: data.lastTickerAt ?? 0,
		missingCredentials: data.missingCredentials ?? [],
		sabbath: data.sabbath,
		mode: data.mode
	}));
</script>

<svelte:head>
	<title>SOL DCA Dashboard</title>
	<meta name="description" content="SOL DCA Dashboard — V6 验证策略" />
</svelte:head>

<TickerStream {dashboard} />
