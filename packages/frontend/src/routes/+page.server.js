import { error } from '@sveltejs/kit';

/**
 * Server load — SSR 拿初始 state
 * 浏览器后由 WebSocket 接管实时推流（直连 worker URL，不走 Pages）
 *
 * mode: 从 cookie 读 (跟 localStorage 同步), 决定拉 demo 还是 live DO
 *   首次访问无 cookie → 默认 demo
 */
export async function load({ platform, fetch, cookies }) {
	if (!platform?.env?.SOL_DCA_WORKER) {
		return {
			portfolio: null,
			paused: false,
			okxWsState: 'unknown',
			lastTickerPrice: 0,
			missingCredentials: [],
			ts: Date.now(),
			warning: 'SOL_DCA_WORKER service binding not configured'
		};
	}
	const cookieMode = cookies.get('sol-dca-mode');
	const mode = cookieMode === 'live' ? 'live' : 'demo';
	const res = await platform.env.SOL_DCA_WORKER.fetch(
		`https://do/state?mode=${mode}`,
		{ method: 'GET' }
	);
	if (!res.ok) {
		throw error(500, `worker /state returned ${res.status}`);
	}
	const data = await res.json();
	return {
		portfolio: data.portfolio,
		paused: data.paused,
		okxWsState: data.okxWsState,
		lastTickerPrice: data.lastTickerPrice,
		lastTickerAt: data.lastTickerAt,
		missingCredentials: data.missingCredentials ?? [],
		sabbath: data.sabbath,
		ts: data.ts,
		mode
	};
}
