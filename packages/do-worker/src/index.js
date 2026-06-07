/**
 * Cloudflare Worker 入口 — SOL DCA Dashboard
 *
 * 责任：
 * 1. WebSocket 升级（浏览器 dashboard 实时推流）
 * 2. HTTP API 路由（Pages Functions 通过 service binding 转发到 DO）
 * 3. Durable Object 入口（导出 TickerHub class 给 wrangler 识别）
 *
 * 部署：单独 worker（不被 SvelteKit Pages 包），DO 跟 WS 都在这。
 * 前端 Pages Function 走 service binding `SOL_DCA_WORKER.fetch(req)` 调进来。
 *
 * 路由：
 *   GET  /ws              → 升级 WS，TickerHub 处理
 *   GET  /state           → TickerHub 当前 portfolio + ticker
 *   POST /control         → TickerHub 控制指令
 *   GET  /health          → 健康检查
 */

export { TickerHub } from './ticker-hub.js';

const HUB_NAME = 'sol-usdt';

export default {
	async fetch(request, env, ctx) {
		const url = new URL(request.url);
		const path = url.pathname;

		// 健康检查（cheap, 不走 DO）
		if (path === '/health') {
			return new Response(JSON.stringify({
				ok: true,
				ts: Date.now(),
				hubName: HUB_NAME
			}), {
				headers: { 'Content-Type': 'application/json' }
			});
		}

		// DO 不存在（dev 模式 binding 缺失）
		if (!env.SOL_DCA_TICKER_HUB) {
			return new Response(
				JSON.stringify({ error: 'SOL_DCA_TICKER_HUB binding missing — check wrangler.toml' }),
				{ status: 503, headers: { 'Content-Type': 'application/json' } }
			);
		}

		const stub = env.SOL_DCA_TICKER_HUB.get(
			env.SOL_DCA_TICKER_HUB.idFromName(HUB_NAME)
		);

		// WS 路由 — 透传原始 request（含 Upgrade header）
		if (path === '/ws' && request.headers.get('Upgrade') === 'websocket') {
			return stub.fetch(request);
		}

		// HTTP 路由 — 转发到 DO 内部路由
		if (path === '/state' || path === '/control') {
			return stub.fetch(new Request(
				`https://do${path}${url.search}`,
				{
					method: request.method,
					headers: request.headers,
					body: request.method !== 'GET' ? request.body : undefined
				}
			));
		}

		return new Response(
			JSON.stringify({
				error: 'not found',
				available: ['/health', '/ws (websocket upgrade)', '/state', '/control (POST)']
			}),
			{ status: 404, headers: { 'Content-Type': 'application/json' } }
		);
	}
};
