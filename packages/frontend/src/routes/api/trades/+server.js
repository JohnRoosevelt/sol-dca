import { json } from '@sveltejs/kit';

/**
 * GET /api/trades?limit=50 — 最近交易记录
 * 从 D1 直读（Pages Function 不绕 worker，零延迟）
 */
export async function GET({ platform, url }) {
	if (!platform?.env?.SOL_DCA_DB) {
		return json({ trades: [], warning: 'SOL_DCA_DB not bound' });
	}
	const limit = Math.min(parseInt(url.searchParams.get('limit') || '50'), 200);
	const { results } = await platform.env.SOL_DCA_DB.prepare(
		'SELECT * FROM trades ORDER BY created_at DESC LIMIT ?'
	)
		.bind(limit)
		.all();
	return json({ trades: results });
}
