/**
 * TOTP grace-period store.
 * Tracks whether the user has verified TOTP within the last 30 minutes
 * to avoid repeated 2FA prompts when switching modes.
 */

import { TOTP_SECRET } from '$lib/config.js';

export const TOTP_VERIFIED_KEY = 'sol-dca-totp-verified-at';
export const GRACE_MS = 30 * 60 * 1000; // 30 minutes

/** Read localStorage timestamp and return true if within the 30-minute window. */
export function isWithinGrace() {
	if (typeof window === 'undefined') return false;
	const raw = localStorage.getItem(TOTP_VERIFIED_KEY);
	if (!raw) return false;
	const ts = Number(raw);
	if (!Number.isFinite(ts)) return false;
	return Date.now() - ts < GRACE_MS;
}

/** Write current timestamp after successful TOTP verification. */
export function markTotpVerified() {
	if (typeof window === 'undefined') return;
	localStorage.setItem(TOTP_VERIFIED_KEY, String(Date.now()));
}

/** Create a reactive TOTP grace-period store.
 *  Note: This file is logic-only (no $state/$derived at module level since
 *  this module is imported by non-Svelte contexts too). Use the functions
 *  above directly; the Svelte component can call them reactively.
 */
export function createTotpStore() {
	return {
		isWithinGrace,
		markTotpVerified,
		TOTP_VERIFIED_KEY,
		GRACE_MS
	};
}
