import { json } from '@sveltejs/kit';
import { dev } from '$app/environment';

/**
 * GET /api/trades?limit=50 — 最近交易记录
 *
 * dev 阶段:走 service binding → worker → DO 内存 (recentTrades 环形缓冲)
 *   (dev 阶段两个 miniflare 进程 D1 文件不互通, 直读 D1 永远空)
 * prod 阶段:直读 D1 (同 database_id, 跟 worker 共享, 完整历史)
 */
export async function GET({ platform, url }) {
	const limit = Math.min(parseInt(url.searchParams.get('limit') || '50'), 200);

	if (dev && platform?.env?.SOL_DCA_WORKER) {
		const res = await platform.env.SOL_DCA_WORKER.fetch(
			`https://do/recent_trades?limit=${limit}`,
			{ method: 'GET' }
		);
		if (res.ok) return json(await res.json());
		// service binding 失败兜底走 D1
	}

	if (!platform?.env?.SOL_DCA_DB) {
		return json({ trades: [], warning: 'SOL_DCA_DB not bound' });
	}
	const { results } = await platform.env.SOL_DCA_DB.prepare(
		'SELECT * FROM trades ORDER BY created_at DESC LIMIT ?'
	)
		.bind(limit)
		.all();
	return json({ trades: results });
}
