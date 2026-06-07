<script>
	import TickerStream from '$lib/components/TickerStream.svelte';
	let { data } = $props();
</script>

<svelte:head>
	<title>SOL DCA Dashboard</title>
	<meta name="description" content="SOL DCA Dashboard — V6 验证策略" />
</svelte:head>

<TickerStream
	initial={{
		portfolio: data.portfolio,
		paused: data.paused,
		okxWsState: data.okxWsState,
		lastTickerPrice: data.lastTickerPrice,
		lastTickerAt: data.lastTickerAt ?? 0,
		missingCredentials: data.missingCredentials ?? [],
		sabbath: data.sabbath,
		mode: data.mode
	}}
/>
