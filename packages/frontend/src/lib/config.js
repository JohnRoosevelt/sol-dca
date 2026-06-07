/**
 * Frontend runtime config — 通过 SvelteKit env 注入
 *
 * PUBLIC_WS_URL: WS 连接 URL
 *   dev:  ws://localhost:8787/ws
 *   prod: wss://sol-dca-do-worker.<sub>.workers.dev/ws
 *
 * PUBLIC_TOTP_SECRET: TOTP 2FA secret
 *   dev:  从 .env 读
 *   prod:  从 .env.production 读（build 时 bake 进 bundle）
 *         密钥不写进 wrangler.toml，始终走 env 文件
 */

import { PUBLIC_WS_URL, PUBLIC_TOTP_SECRET } from '$env/static/public';

export const WS_URL = PUBLIC_WS_URL;
export const TOTP_SECRET = PUBLIC_TOTP_SECRET || '';
