import { error, json } from '@sveltejs/kit';

/**
 * GET /api/state — 当前 portfolio + ticker 状态
 * 从 Worker (TickerHub DO) 读，通过 service binding 转发。
 */
export async function GET({ platform }) {
	if (!platform?.env?.SOL_DCA_WORKER) {
		throw error(503, 'SOL_DCA_WORKER service binding not configured — check wrangler.toml');
	}
	const res = await platform.env.SOL_DCA_WORKER.fetch('https://do/state', { method: 'GET' });
	if (!res.ok) {
		const text = await res.text();
		throw error(res.status, `worker /state: ${text}`);
	}
	return json(await res.json());
}
