<script>
	import { onMount, onDestroy } from 'svelte';
	import { verifyTOTP, totpCountdown } from '$lib/totp.js';
	import { TOTP_SECRET } from '$lib/config.js';

	let { open = $bindable(false), onVerify = () => {}, onCancel = () => {} } = $props();

	let digits = $state(['', '', '', '', '', '']);
	let errorMsg = $state('');
	let verifying = $state(false);
	let countdown = $state(30);
	let countdownTimer = null;
	let inputRefs = $state([]);

	function startCountdown() {
		clearInterval(countdownTimer);
		countdown = totpCountdown();
		countdownTimer = setInterval(() => {
			countdown = totpCountdown();
		}, 1000);
	}

	function stopCountdown() {
		clearInterval(countdownTimer);
		countdownTimer = null;
	}

	$effect(() => {
		if (open) {
			digits = ['', '', '', '', '', ''];
			errorMsg = '';
			verifying = false;
			startCountdown();
			setTimeout(() => inputRefs[0]?.focus(), 50);
		} else {
			stopCountdown();
		}
	});

	function handlePaste(e) {
		e.preventDefault();
		const pasted = (e.clipboardData || window.clipboardData).getData('text').replace(/\D/g, '');
		if (!pasted) return;
		const chars = pasted.slice(0, 6).split('');
		digits = [...chars, '', '', '', '', ''].slice(0, 6);
		const nextEmpty = digits.findIndex((d) => d === '');
		if (nextEmpty >= 0) {
			inputRefs[nextEmpty]?.focus();
		} else {
			inputRefs[5]?.focus();
		}
	}

	function handleInput(idx, e) {
		const val = e.target.value.replace(/\D/g, '');
		if (!val) return;
		const char = val[val.length - 1];
		digits[idx] = char;
		if (idx < 5) {
			inputRefs[idx + 1]?.focus();
		}
		errorMsg = '';
	}

	function handleKeydown(idx, e) {
		if (e.key === 'Backspace') {
			if (digits[idx] === '' && idx > 0) {
				inputRefs[idx - 1]?.focus();
				digits[idx - 1] = '';
				digits = [...digits];
			} else {
				digits[idx] = '';
				digits = [...digits];
			}
			errorMsg = '';
		} else if (e.key === 'ArrowLeft' && idx > 0) {
			inputRefs[idx - 1]?.focus();
		} else if (e.key === 'ArrowRight' && idx < 5) {
			inputRefs[idx + 1]?.focus();
		} else if (e.key === 'Enter') {
			submit();
		}
	}

	async function submit() {
		const code = digits.join('');
		if (code.length !== 6) {
			errorMsg = '请输入完整的 6 位验证码';
			return;
		}
		verifying = true;
		errorMsg = '';
		try {
			const valid = await verifyTOTP(TOTP_SECRET || '', code);
			if (valid) {
				onVerify();
			} else {
				errorMsg = '验证码错误，请重试';
				open = false;
				onCancel();
			}
		} catch (_) {
			errorMsg = '验证失败，请重试';
		} finally {
			verifying = false;
		}
	}

	function cancel() {
		open = false;
		digits = ['', '', '', '', '', ''];
		errorMsg = '';
		onCancel();
	}

	onDestroy(() => stopCountdown());
</script>

{#if open}
<div class="overlay" role="dialog" aria-modal="true" aria-label="TOTP 验证码">
	<div class="modal">
		<div class="modal-header">
			<h3>输入 TOTP 验证码</h3>
			<p>请输入 Google Authenticator 中的 6 位动态验证码，确认切换到 <strong>Live 模式</strong>。</p>
		</div>

		<div class="code-row">
			{#each digits as digit, i}
				<input
					bind:this={inputRefs[i]}
					type="text"
					inputmode="numeric"
					pattern="[0-9]"
					maxlength="6"
					class="code-input"
					class:filled={digit !== ''}
					value={digit}
					oninput={(e) => handleInput(i, e)}
					onkeydown={(e) => handleKeydown(i, e)}
					onpaste={handlePaste}
					autocomplete="one-time-code"
					aria-label={`第 ${i + 1} 位`}
				/>
			{/each}
		</div>

		<div class="countdown-row">
			<span class="countdown-label">剩余时间</span>
			<span class="countdown-value" class:urgent={countdown <= 10}>
				{countdown}s
			</span>
		</div>

		{#if errorMsg}
			<div class="error" role="alert">{errorMsg}</div>
		{/if}

		<div class="actions">
			<button class="cancel" onclick={cancel} disabled={verifying}>取消</button>
			<button class="confirm" onclick={submit} disabled={verifying || digits.some(d => d === '')}>
				{verifying ? '验证中…' : '确认切换'}
			</button>
		</div>
	</div>
</div>
{/if}

<style>
	.overlay {
		position: fixed;
		inset: 0;
		background: rgba(0, 0, 0, 0.75);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 1000;
		backdrop-filter: blur(2px);
	}
	.modal {
		background: #18181b;
		border: 1px solid #3f3f46;
		border-radius: 12px;
		padding: 1.75rem 2rem;
		width: min(420px, 90vw);
		box-shadow: 0 24px 64px rgba(0,0,0,0.6);
	}
	.modal-header {
		margin-bottom: 1.5rem;
	}
	.modal-header h3 {
		margin: 0 0 0.5rem;
		font-size: 1.1rem;
		color: #f4f4f5;
	}
	.modal-header p {
		margin: 0;
		font-size: 0.85rem;
		color: #a1a1aa;
		line-height: 1.5;
	}
	.modal-header strong {
		color: #f87171;
	}
	.code-row {
		display: flex;
		gap: 0.5rem;
		justify-content: center;
		margin-bottom: 1rem;
	}
	.code-input {
		width: 48px;
		height: 56px;
		text-align: center;
		font-size: 1.5rem;
		font-family: ui-monospace, monospace;
		font-weight: 600;
		background: #09090b;
		border: 1px solid #3f3f46;
		border-radius: 8px;
		color: #f4f4f5;
		outline: none;
		transition: border-color 0.15s;
		caret-color: #3b82f6;
	}
	.code-input:focus {
		border-color: #3b82f6;
		box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.25);
	}
	.code-input.filled {
		border-color: #52525b;
	}
	.countdown-row {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 0.5rem;
		margin-bottom: 1rem;
	}
	.countdown-label {
		font-size: 0.8rem;
		color: #71717a;
	}
	.countdown-value {
		font-size: 0.9rem;
		font-family: ui-monospace, monospace;
		font-weight: 600;
		color: #a1a1aa;
		transition: color 0.3s;
	}
	.countdown-value.urgent {
		color: #f87171;
	}
	.error {
		background: #7f1d1d;
		color: #fca5a5;
		border-radius: 6px;
		padding: 0.5rem 0.75rem;
		font-size: 0.85rem;
		margin-bottom: 1rem;
		text-align: center;
	}
	.actions {
		display: flex;
		gap: 0.75rem;
		justify-content: flex-end;
	}
	button {
		padding: 0.5rem 1.25rem;
		border-radius: 6px;
		font-size: 0.875rem;
		cursor: pointer;
		border: none;
		transition: opacity 0.15s;
	}
	button:disabled {
		opacity: 0.45;
		cursor: not-allowed;
	}
	.cancel {
		background: #27272a;
		color: #a1a1aa;
	}
	.cancel:hover:not(:disabled) {
		background: #3f3f46;
		color: #e4e4e7;
	}
	.confirm {
		background: #2563eb;
		color: white;
	}
	.confirm:hover:not(:disabled) {
		background: #1d4ed8;
	}
</style>
