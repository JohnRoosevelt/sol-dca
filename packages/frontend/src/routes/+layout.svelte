<script>
	import favicon from '$lib/assets/favicon.svg';

	let { children } = $props();
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
</svelte:head>

{@render children()}

<style>
	/* 全局: 整个 viewport 黑底, 避免 PC 端 max-width 外露白 */
	:global(html, body) {
		background: #0a0a0a;
		margin: 0;
		padding: 0;
	}
	:global(body) {
		min-height: 100vh;
	}
</style>
