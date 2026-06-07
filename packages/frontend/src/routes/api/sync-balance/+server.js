import { error, json } from '@sveltejs/kit';

/**
 * GET /api/sync-balance — 手动触发 OKX 余额同步，返回更新后的 portfolio
 *   ?mode=demo|live — 选 demo/live DO instance (默认 demo)
 */
export async function GET({ platform, url }) {
	if (!platform?.env?.SOL_DCA_WORKER) {
		throw error(503, 'SOL_DCA_WORKER service binding not configured');
	}
	const mode = url.searchParams.get('mode') === 'live' ? 'live' : 'demo';
	const res = await platform.env.SOL_DCA_WORKER.fetch(
		`https://do/sync-balance?mode=${mode}`,
		{ method: 'GET' }
	);
	if (!res.ok) {
		const text = await res.text();
		throw error(res.status, `worker /sync-balance: ${text}`);
	}
	return json(await res.json());
}
