/**
 * API client for the SOL DCA backend.
 * All functions return a meaningful result structure rather than throwing.
 */

// ---------------------------------------------------------------------------
// Shared types (JSDoc, not TS — per user JS-first preference)
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} Portfolio
 * @property {number} usdtBalance
 * @property {number} solHolding
 * @property {number|null} lastBuyPrice
 * @property {number|null} avgBuyPrice
 * @property {number|null} realizedPnL
 * @property {boolean} isStarted
 * @property {string|null} currentRoundId
 * @property {number} monthSpentThisMonth
 */

/**
 * @typedef {Object} Signal
 * @property {string|number} id
 * @property {string} action  'buy' | 'sell' | 'hold'
 * @property {number} price
 * @property {string} reason
 * @property {number} [drawdown_pct]
 * @property {number} [profit_pct]
 * @property {string} [created_at]
 */

/**
 * @typedef {Object} Trade
 * @property {string|number} id
 * @property {string} side  'buy' | 'sell'
 * @property {number} price
 * @property {number} amount_usdt
 * @property {number} amount_sol
 * @property {string} [reason]
 * @property {string} [created_at]
 */

/**
 * @typedef {Object} HistoryEntry
 * @property {string} _type  'signal' | 'trade'
 * @property {string} _key
 * @property {string} [created_at]
 * @property {string} [action]
 * @property {string} [side]
 * @property {number} [price]
 * @property {number} [amount_usdt]
 * @property {number} [amount_sol]
 * @property {string} [reason]
 * @property {number} [drawdown_pct]
 * @property {number} [profit_pct]
 */

/**
 * @typedef {'connecting'|'open'|'closed'|'error'} WsState
 */

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Wrap a fetch call, return { ok, data, error } without throwing. */
async function safeFetch(input, init) {
	try {
		const res = await fetch(input, init);
		let data;
		try { data = await res.json(); } catch (_) { data = {}; }
		if (!res.ok) {
			return { ok: false, data, error: `HTTP ${res.status}`, status: res.status };
		}
		return { ok: true, data, status: res.status };
	} catch (err) {
		return { ok: false, data: null, error: String(err) };
	}
}

// ---------------------------------------------------------------------------
// API functions
// ---------------------------------------------------------------------------

/**
 * Fetch current balance snapshot from OKX (USDT + SOL).
 * @param {string} mode  'demo' | 'live'
 * @returns {Promise<{
 *   ok: boolean,
 *   portfolio: Portfolio|null,
 *   paused: boolean,
 *   okxWsState: string,
 *   lastTickerPrice: number,
 *   lastTickerAt: number,
 *   missingCredentials: string[],
 *   recentSignals: Signal[],
 *   recentTrades: Trade[],
 *   error?: string
 * }>}
 */
export async function syncBalance(mode) {
	const result = await safeFetch(`/api/sync-balance?mode=${mode}`);
	return {
		ok: result.ok,
		portfolio: result.data?.portfolio ?? null,
		paused: result.data?.paused ?? false,
		okxWsState: result.data?.okxWsState ?? 'init',
		lastTickerPrice: result.data?.lastTickerPrice ?? 0,
		lastTickerAt: result.data?.lastTickerAt ?? 0,
		missingCredentials: result.data?.missingCredentials ?? [],
		recentSignals: result.data?.recentSignals ?? [],
		recentTrades: result.data?.recentTrades ?? [],
		error: result.error
	};
}

/**
 * Alias for syncBalance — kept for backward compatibility with existing call sites.
 * @param {string} mode
 */
export async function fetchState(mode) {
	return syncBalance(mode);
}

/**
 * Send a control action to the DCA engine.
 * @param {string} mode
 * @param {string} action  'pause' | 'resume' | 'init_dca' | 'manual_buy' | ...
 * @param {Object} [extra]  Additional body fields
 * @returns {Promise<{ ok: boolean, data: Object, error?: string }>}
 */
export async function sendControl(mode, action, extra = {}) {
	const result = await safeFetch(`/api/control?mode=${mode}`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ action, ...extra })
	});
	return {
		ok: result.ok,
		data: result.data ?? {},
		error: result.error
	};
}

/**
 * Reset the DCA state (sell all SOL + clear history).
 * @param {string} mode
 * @returns {Promise<{ ok: boolean, portfolio: Portfolio|null, error?: string }>}
 */
export async function reset(mode) {
	const result = await safeFetch(`/api/reset?mode=${mode}`, { method: 'POST' });
	return {
		ok: result.ok,
		portfolio: result.data?.portfolio ?? null,
		error: result.error
	};
}

/**
 * Fetch historical decision signals.
 * @param {string} mode
 * @param {number} [limit]
 * @returns {Promise<{ ok: boolean, signals: Signal[], error?: string }>}
 */
export async function fetchSignals(mode, limit = 200) {
	const result = await safeFetch(`/api/signals?mode=${mode}&limit=${limit}`);
	return {
		ok: result.ok,
		signals: Array.isArray(result.data?.signals) ? result.data.signals : [],
		error: result.error
	};
}

/**
 * Fetch historical trades.
 * @param {string} mode
 * @param {number} [limit]
 * @returns {Promise<{ ok: boolean, trades: Trade[], error?: string }>}
 */
export async function fetchTrades(mode, limit = 100) {
	const result = await safeFetch(`/api/trades?mode=${mode}&limit=${limit}`);
	return {
		ok: result.ok,
		trades: Array.isArray(result.data?.trades) ? result.data.trades : [],
		error: result.error
	};
}
