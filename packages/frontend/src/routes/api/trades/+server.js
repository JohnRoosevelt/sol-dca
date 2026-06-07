import { json } from '@sveltejs/kit';

/**
 * GET /api/trades?limit=50&mode=demo|live — 最近交易记录
 * 全部走 service binding → DO Worker → DO storage
 */
export async function GET({ platform, url }) {
	const limit = Math.min(parseInt(url.searchParams.get('limit') || '50'), 200);
	const mode = url.searchParams.get('mode') === 'live' ? 'live' : 'demo';

	if (!platform?.env?.SOL_DCA_WORKER) {
		return json({ trades: [], warning: 'SOL_DCA_WORKER not bound' });
	}

	const res = await platform.env.SOL_DCA_WORKER.fetch(
		`https://do/recent_trades?mode=${mode}&limit=${limit}`,
		{ method: 'GET' }
	);
	if (res.ok) return json(await res.json());
	return json({ trades: [], error: 'worker request failed' });
}