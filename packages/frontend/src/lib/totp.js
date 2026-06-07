/**
 * TOTP utilities — pure JS, no external dependencies.
 * Uses Web Crypto API (crypto.subtle) for HMAC-SHA1.
 *
 * Algorithm: SHA-1, 6 digits, 30-second window, RFC 6238 compliant.
 */

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/**
 * Decode a Base32 string into a Uint8Array.
 * @param {string} input - Base32-encoded string (uppercase, may contain padding).
 * @returns {Uint8Array}
 */
function base32Decode(input) {
	const cleaned = input.toUpperCase().replace(/[^A-Z2-7]/g, '');
	const chars = cleaned.split('');
	const bytes = [];
	let buffer = 0;
	let bitsLeft = 0;

	for (const char of chars) {
		const val = BASE32_ALPHABET.indexOf(char);
		if (val === -1) continue;
		buffer = (buffer << 5) | val;
		bitsLeft += 5;
		if (bitsLeft >= 8) {
			bitsLeft -= 8;
			bytes.push((buffer >>> bitsLeft) & 0xff);
		}
	}

	return new Uint8Array(bytes);
}

/**
 * Compute the TOTP code for a given counter value.
 * @param {Uint8Array} secret - Decoded secret key bytes.
 * @param {bigint} counter - Time counter (floor(timestamp / 30)).
 * @returns {Promise<number>} - 6-digit TOTP code.
 */
async function computeTOTP(secret, counter) {
	const counterBytes = new Uint8Array(8);
	const view = new DataView(counterBytes.buffer);
	view.setBigUint64(0, counter, false);

	const key = await crypto.subtle.importKey(
		'raw',
		secret,
		{ name: 'HMAC', hash: 'SHA-1' },
		false,
		['sign']
	);

	const sig = await crypto.subtle.sign('HMAC', key, counterBytes);
	const sigBytes = new Uint8Array(sig);
	const offset = sigBytes[sigBytes.length - 1] & 0x0f;
	const code =
		((sigBytes[offset] & 0x7f) << 24) |
		((sigBytes[offset + 1] & 0xff) << 16) |
		((sigBytes[offset + 2] & 0xff) << 8) |
		(sigBytes[offset + 3] & 0xff);

	return code % 1000000;
}

/**
 * Verify a user-entered TOTP code against a Base32 secret.
 * Allows +/- 1 time window to handle clock drift.
 *
 * @param {string} secret - Base32-encoded secret.
 * @param {string} code - 6-digit code entered by user (string).
 * @param {number} [window=1] - How many windows before/after to check.
 * @returns {Promise<boolean>} - true if code is valid.
 */
export async function verifyTOTP(secret, code, window = 1) {
	if (!code || !/^\d{6}$/.test(code)) return false;
	const padded = code.replace(/\D/g, '');
	if (padded.length !== 6) return false;

	const secretBytes = base32Decode(secret);
	const now = Math.floor(Date.now() / 1000);
	const counter = BigInt(Math.floor(now / 30));

	try {
		for (let i = -window; i <= window; i++) {
			const c = counter + BigInt(i);
			const expected = await computeTOTP(secretBytes, c);
			const expectedStr = String(expected).padStart(6, '0');
			if (expectedStr === padded) return true;
		}
	} catch (_) {
		return false;
	}
	return false;
}

/**
 * Get remaining seconds in the current TOTP window.
 * @returns {number} - Seconds until next code (1-30).
 */
export function totpCountdown() {
	return 30 - (Math.floor(Date.now() / 1000) % 30);
}
