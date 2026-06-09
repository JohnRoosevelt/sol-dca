/**
 * WebSocket reconnection manager
 * Implements exponential backoff + circuit breaker to prevent
 * DO quota exhaustion from repeated reconnection attempts.
 */

export const RECONNECT_BASE_MS = 1_000;
export const RECONNECT_MAX_DELAY_MS = 60_000;
export const RECONNECT_CIRCUIT_BREAKER = 8;

export function createReconnectManager({ onScheduleReconnect, onCircuitBreaker }) {
	let attempts = $state(0);
	let stopped = $state(false);

	/** Exponential backoff delay for next reconnect attempt */
	function nextReconnectDelay() {
		// 1s, 2s, 4s, 8s, 16s, 32s, 60s, 60s, ...
		return Math.min(RECONNECT_MAX_DELAY_MS, RECONNECT_BASE_MS * Math.pow(2, attempts));
	}

	/** Schedule automatic reconnect with backoff. Returns true if scheduled, false if circuit-broken. */
	function scheduleReconnect() {
		if (stopped) return false;
		if (attempts >= RECONNECT_CIRCUIT_BREAKER) {
			stopped = true;
			onCircuitBreaker?.();
			return false;
		}
		const delay = nextReconnectDelay();
		attempts++;
		onScheduleReconnect?.(delay, attempts);
		return true;
	}

	/** Manual reconnect — resets backoff state (circuit-breaker recovery path) */
	function manualReconnect() {
		attempts = 0;
		stopped = false;
	}

	return {
		get attempts() { return attempts; },
		get stopped() { return stopped; },
		nextReconnectDelay,
		scheduleReconnect,
		manualReconnect
	};
}
