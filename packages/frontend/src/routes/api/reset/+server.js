import { error, json } from '@sveltejs/kit';

/**
 * POST /api/reset — 清空 DO storage + D1 portfolio_state, 重新拉 OKX 真实账户
 *   Worker /reset 端点内部会先 sell-all SOL → USDT (user 要求 reset 走这条复合路径)
 *   转发到 TickerHub (经 Worker → DO)
 *   ?mode=demo|live — 选 demo/live DO instance (默认 demo, 只清当前 mode 的 portfolio)
 */
export async function POST({ platform, url }) {
	if (!platform?.env?.SOL_DCA_WORKER) {
		throw error(503, 'SOL_DCA_WORKER service binding not configured');
	}
	const mode = url.searchParams.get('mode') === 'live' ? 'live' : 'demo';
	const res = await platform.env.SOL_DCA_WORKER.fetch(
		`https://do/reset?mode=${mode}`,
		{ method: 'POST' }
	);
	const text = await res.text();
	try {
		return json(JSON.parse(text), { status: res.status });
	} catch {
		return json({ raw: text }, { status: res.status });
	}
}
