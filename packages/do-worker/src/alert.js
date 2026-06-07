/**
 * 飞书 / Bark / 通用 webhook 报警
 *
 * 触发条件（V10 之前先用简单规则）：
 * - WS 断开
 * - ticker 30s 没收到
 * - 下单失败
 * - 余额异常（耗尽 / 偏离预期）
 */

const FEISHU_HOSTS = ['open.feishu.cn', 'larksuite'];
const BARK_HOST = 'api.day.app';

async function postJson(url, payload) {
	const res = await fetch(url, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(payload)
	});
	return { ok: res.ok, status: res.status };
}

async function postFeishu(url, title, body, level) {
	const color = { info: 'blue', warn: 'orange', error: 'red' }[level] || 'blue';
	return postJson(url, {
		msg_type: 'interactive',
		card: {
			header: { title: { tag: 'plain_text', content: title }, template: color },
			elements: [{ tag: 'div', text: { tag: 'plain_text', content: body } }]
		}
	});
}

async function postBark(url, title, body, level) {
	const u = new URL(url);
	u.searchParams.set('title', title);
	u.searchParams.set('body', body);
	u.searchParams.set('level', level);
	const res = await fetch(u.toString(), { method: 'GET' });
	return { ok: res.ok, status: res.status };
}

function isFeishu(url) {
	try {
		const host = new URL(url).host;
		return FEISHU_HOSTS.some((h) => host.includes(h));
	} catch {
		return false;
	}
}

function isBark(url) {
	try {
		return new URL(url).host.includes(BARK_HOST);
	} catch {
		return false;
	}
}

/**
 * 发送报警
 * @param {string} url
 * @param {string} title
 * @param {string} body
 * @param {string} [level] info / warn / error
 * @returns {Promise<{ok: boolean, status?: number, error?: string}>}
 */
export async function sendAlert(url, title, body, level = 'info') {
	if (!url) {
		console.log(`[alert:${level}] ${title} -- ${body}`);
		return { ok: true, skipped: true };
	}
	try {
		if (isFeishu(url)) return await postFeishu(url, title, body, level);
		if (isBark(url)) return await postBark(url, title, body, level);
		return await postJson(url, { title, body, level, ts: new Date().toISOString() });
	} catch (err) {
		console.error('[alert] send failed:', err);
		return { ok: false, error: String(err) };
	}
}
