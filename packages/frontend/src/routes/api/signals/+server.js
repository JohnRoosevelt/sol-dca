import { json } from '@sveltejs/kit';
import { dev } from '$app/environment';

/**
 * GET /api/signals?limit=100&mode=demo|live — 最近策略信号
 *
 * dev 阶段:走 service binding → worker → DO 内存 (recentSignals 环形缓冲, DO instance 已是指定 mode)
 * prod 阶段:直读 D1 (同 database_id, 跟 worker 共享, 完整历史)
 *   signals 表 mode 字段做 audit label, 按 ?mode= 过滤
 */
export async function GET({ platform, url }) {
	const limit = Math.min(parseInt(url.searchParams.get('limit') || '100'), 500);
	const mode = url.searchParams.get('mode') === 'live' ? 'live' : 'demo';

	if (dev && platform?.env?.SOL_DCA_WORKER) {
		const res = await platform.env.SOL_DCA_WORKER.fetch(
			`https://do/recent_signals?mode=${mode}&limit=${limit}`,
			{ method: 'GET' }
		);
		if (res.ok) return json(await res.json());
		// service binding 失败兜底走 D1
	}

	if (!platform?.env?.SOL_DCA_DB) {
		return json({ signals: [], warning: 'SOL_DCA_DB not bound' });
	}
	const { results } = await platform.env.SOL_DCA_DB.prepare(
		'SELECT * FROM signals WHERE mode = ? ORDER BY created_at DESC LIMIT ?'
	)
		.bind(mode, limit)
		.all();
	return json({ signals: results });
}
