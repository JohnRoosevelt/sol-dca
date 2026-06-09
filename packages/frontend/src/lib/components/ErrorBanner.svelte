<script>
	let { message = '', missingCredentials = [], type = 'error' } = $props();
</script>

{#if type === 'warning' && missingCredentials.length > 0}
	<div class="error credentials-missing">
		<strong>OKX credentials missing:</strong>
		{missingCredentials.join(', ')}
		<br />
		<small>put via <code>wrangler secret put &lt;KEY&gt;</code> (remote) or write to <code>do-worker/.dev.vars</code> (local). See <code>do-worker/wrangler.toml</code> for required keys.</small>
	</div>
{:else if message}
	<div class="error">{message}</div>
{/if}

<style>
	.error {
		background: #7f1d1d;
		color: #fee2e2;
		padding: 0.75rem;
		border-radius: 4px;
		margin-bottom: 1rem;
	}
	.credentials-missing {
		border: 2px solid #dc2626;
	}
	.credentials-missing code {
		background: #1c1c1c;
		padding: 0.1rem 0.4rem;
		border-radius: 3px;
		font-size: 0.85em;
	}
	.credentials-missing small {
		display: block;
		margin-top: 0.5rem;
		color: #fca5a5;
	}
</style>
