/**
 * Formatting utilities for the dashboard.
 */

/**
 * Format a USD price value with configurable decimal places.
 * @param value - The numeric price
 * @param decimals - Number of decimal places (default 2)
 */
export function formatPrice(value, decimals = 2) {
	if (value == null || !Number.isFinite(value)) return '—';
	return `$${value.toFixed(decimals)}`;
}

/**
 * Format a SOL quantity with configurable decimal places.
 * @param value - The SOL amount
 * @param decimals - Number of decimal places (default 4)
 */
export function formatSol(value, decimals = 4) {
	if (value == null || !Number.isFinite(value)) return '—';
	return `${value.toFixed(decimals)} SOL`;
}

/**
 * Format a Unix timestamp to a locale time string.
 * @param ts - Unix timestamp in milliseconds, or null
 */
export function formatTime(ts) {
	if (!ts) return '';
	return new Date(ts).toLocaleTimeString();
}

/**
 * Return age of a timestamp in seconds (0 if ts is null/invalid).
 * @param ts - Unix timestamp in milliseconds, or null
 * @returns Age in seconds, or 0 if ts is null
 */
export function formatAge(ts) {
	if (!ts) return 0;
	return Math.max(0, Math.floor((Date.now() - ts) / 1000));
}

/**
 * Format a profit/loss value with sign and percentage.
 * @param value - Absolute profit/loss amount
 * @param pct - Percentage
 */
export function formatProfit(value, pct) {
	const sign = value >= 0 ? '+' : '';
	return `${sign}$${value.toFixed(2)} (${pct.toFixed(2)}%)`;
}

/**
 * Get ticker metadata: display text and age in seconds.
 * @param ts - Last ticker timestamp in milliseconds, or null
 * @returns { text: string, ageSec: number }
 */
export function getTickerMeta(ts) {
	return {
		text: ts ? new Date(ts).toLocaleTimeString() : '',
		ageSec: formatAge(ts)
	};
}
