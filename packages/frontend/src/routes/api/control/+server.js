import { error, json } from '@sveltejs/kit';

/**
 * POST /api/control — 转发控制指令到 TickerHub (经 Worker → DO)
 * body: { action: 'pause' | 'resume' | 'manual_sell', amountSol?: number }
 *   ?mode=demo|live — 选 demo/live DO instance (默认 demo)
 */
export async function POST({ platform, request, url }) {
	if (!platform?.env?.SOL_DCA_WORKER) {
		throw error(503, 'SOL_DCA_WORKER service binding not configured');
	}
	const mode = url.searchParams.get('mode') === 'live' ? 'live' : 'demo';
	let body;
	try {
		body = await request.json();
	} catch {
		throw error(400, 'invalid json body');
	}
	if (!body.action) {
		throw error(400, 'action is required');
	}
	const res = await platform.env.SOL_DCA_WORKER.fetch(
		`https://do/control?mode=${mode}`,
		{
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body)
		}
	);
	const text = await res.text();
	try {
		return json(JSON.parse(text), { status: res.status });
	} catch {
		return json({ raw: text }, { status: res.status });
	}
}
