import { json } from '@sveltejs/kit';

/**
 * GET /api/signals?limit=100 — 最近策略信号
 * 从 D1 直读。
 */
export async function GET({ platform, url }) {
	if (!platform?.env?.SOL_DCA_DB) {
		return json({ signals: [], warning: 'SOL_DCA_DB not bound' });
	}
	const limit = Math.min(parseInt(url.searchParams.get('limit') || '100'), 500);
	const { results } = await platform.env.SOL_DCA_DB.prepare(
		'SELECT * FROM signals ORDER BY created_at DESC LIMIT ?'
	)
		.bind(limit)
		.all();
	return json({ signals: results });
}
