<script>
	import TickerStream from '$lib/components/TickerStream.svelte';
	import { createDashboardStore } from '$lib/stores/dashboard.svelte.js';

	let { data } = $props();

	// Create the dashboard store at module level (client-side only).
	// All state/logic lives in the store; TickerStream is a thin shell.
	const dashboard = createDashboardStore({
		portfolio: data.portfolio,
		paused: data.paused,
		okxWsState: data.okxWsState,
		lastTickerPrice: data.lastTickerPrice,
		lastTickerAt: data.lastTickerAt ?? 0,
		missingCredentials: data.missingCredentials ?? [],
		sabbath: data.sabbath,
		mode: data.mode
	});
</script>

<svelte:head>
	<title>SOL DCA Dashboard</title>
	<meta name="description" content="SOL DCA Dashboard — V6 验证策略" />
</svelte:head>

<TickerStream {dashboard} />
