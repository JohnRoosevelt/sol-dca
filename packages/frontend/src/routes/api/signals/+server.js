import { json } from '@sveltejs/kit';

/**
 * GET /api/signals?limit=100&mode=demo|live — 最近策略信号
 * 全部走 service binding → DO Worker → DO storage
 */
export async function GET({ platform, url }) {
	const limit = Math.min(parseInt(url.searchParams.get('limit') || '100'), 500);
	const mode = url.searchParams.get('mode') === 'live' ? 'live' : 'demo';

	if (!platform?.env?.SOL_DCA_WORKER) {
		return json({ signals: [], warning: 'SOL_DCA_WORKER not bound' });
	}

	const res = await platform.env.SOL_DCA_WORKER.fetch(
		`https://do/recent_signals?mode=${mode}&limit=${limit}`,
		{ method: 'GET' }
	);
	if (res.ok) return json(await res.json());
	return json({ signals: [], error: 'worker request failed' });
}