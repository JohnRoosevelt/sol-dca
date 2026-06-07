/**
 * Frontend runtime config — 通过 Vite env var 注入
 *
 * PUBLIC_WS_URL: 浏览器 WebSocket 连接 URL
 *   dev:  ws://localhost:8787/ws
 *   prod: wss://sol-dca-do-worker.<sub>.workers.dev/ws
 *         (Pages dashboard env 注入)
 *
 * PUBLIC_TOTP_SECRET: TOTP 2FA secret
 *   运行时从 Cloudflare Pages 环境变量注入 (wrangler secret put)
 *   用 $env/dynamic/public 避免 build 时 bake 进 bundle
 *   通过 async getter 延迟访问 (避免 SSR build 时 import 失败)
 *
 * Vite 暴露 `PUBLIC_*` 前缀的 env var 到 client 代码 (import.meta.env.PUBLIC_*).
 */

import { PUBLIC_WS_URL } from '$env/static/public';

export const WS_URL = PUBLIC_WS_URL;

let _totpSecret;
export async function getTotpSecret() {
	if (_totpSecret !== undefined) return _totpSecret;
	try {
		const mod = await import('$env/dynamic/public');
		_totpSecret = mod.PUBLIC_TOTP_SECRET || '';
	} catch {
		_totpSecret = '';
	}
	return _totpSecret;
}
