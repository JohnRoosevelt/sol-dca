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
 * Demo / Live 物理隔离：
 *   - 同一个 TickerHub class, 但每个 mode 一个独立 DO instance
 *   - 用 idFromName(`sol-usdt-demo` / `sol-usdt-live`) 区分
 *   - TickerHub constructor 从 state.id.name 推 this.mode = 'demo' | 'live'
 *   - 数据完全独立 (portfolio / signals / trades / okx client / WS 连接)
 *
 * 路由：
 *   GET  /ws              → 升级 WS（?mode=demo|live 选 DO）
 *   GET  /state           → TickerHub portfolio + ticker
 *   GET  /sync-balance     → 手动触发 OKX 余额同步
 *   POST /control         → TickerHub 控制指令
 *   POST /reset           → 清 portfolio + 历史
 *   GET  /health          → 健康检查
 */

export { TickerHub } from './ticker-hub.js';

const HUB_NAMES = {
	demo: 'sol-usdt-demo',
	live: 'sol-usdt-live'
};
const DEFAULT_MODE = 'demo';

/** @param {string | null} mode */
function resolveMode(mode) {
	if (mode === 'live' || mode === 'demo') return mode;
	return DEFAULT_MODE;
}

/** @param {string} mode */
function hubNameFor(mode) {
	return HUB_NAMES[mode] || HUB_NAMES[DEFAULT_MODE];
}

export default {
	async fetch(request, env, ctx) {
		const url = new URL(request.url);
		const path = url.pathname;
		const mode = resolveMode(url.searchParams.get('mode'));
		const hubName = hubNameFor(mode);

		// 健康检查（cheap, 不走 DO）
		if (path === '/health') {
			return new Response(JSON.stringify({
				ok: true,
				ts: Date.now(),
				hubName,
				mode
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
			env.SOL_DCA_TICKER_HUB.idFromName(hubName)
		);

		// WS 路由 — 透传原始 request（含 Upgrade header）
		//   mode 通过 query string 传: /ws?mode=demo
		if (path === '/ws' && request.headers.get('Upgrade') === 'websocket') {
			return stub.fetch(request);
		}

		// HTTP 路由 — 转发到 DO 内部路由
		if (path === '/state' || path === '/control' || path === '/recent_signals' || path === '/recent_trades' || path === '/reset' || path === '/debug/okx-balance' || path === '/sync-balance') {
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
				mode,
				hubName,
				available: [
					'/health',
					'/ws?mode=demo|live (websocket upgrade)',
					'/state?mode=demo|live',
					'/sync-balance?mode=demo|live',
					'/recent_signals?mode=demo|live',
					'/recent_trades?mode=demo|live',
					'/control?mode=demo|live (POST)',
					'/reset?mode=demo|live (POST)',
					'/debug/okx-balance?mode=demo|live (GET)'
				]
			}),
			{ status: 404, headers: { 'Content-Type': 'application/json' } }
		);
	}
};
