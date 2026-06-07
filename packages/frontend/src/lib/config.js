/**
 * Frontend runtime config — 通过 Vite env var 注入
 *
 * PUBLIC_WS_URL: 浏览器 WebSocket 连接 URL
 *   dev:  ws://localhost:8787/ws
 *   prod: wss://sol-dca-do-worker.<sub>.workers.dev/ws
 *         (Pages dashboard env 注入)
 *
 * Vite 暴露 `PUBLIC_*` 前缀的 env var 到 client 代码 (import.meta.env.PUBLIC_*).
 * 设为 $env/static/public 让 SvelteKit 在 build 时替换, 客户端 bundle 直接含字面值.
 */

import { PUBLIC_WS_URL } from '$env/static/public';

export const WS_URL = PUBLIC_WS_URL || 'ws://localhost:8787/ws';
