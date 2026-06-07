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

// 报警 rate limit: 同一 (level + title) 在窗口内只发一次, 避免 WS 重连/启动风暴刷屏飞书
//   info: 5min 冷却 (OKX WS connected / BUY executed 等日常事件)
//   warn: 2min 冷却 (Ticker silent 等需要关注但不紧急)
//   error: 不限 (BUY failed 等紧急事件, 每次都发)
const ALERT_COOLDOWN_MS = {
	info: 5 * 60 * 1000,
	warn: 2 * 60 * 1000
	// error 故意没有 → 紧急事件不限
};
const alertCooldowns = new Map(); // key = `${level}:${title}` → last sent timestamp

/**
 * 发送报警
 * @param {string} url
 * @param {string} title
 * @param {string} body
 * @param {string} [level] info / warn / error
 * @returns {Promise<{ok: boolean, status?: number, error?: string, skipped?: boolean}>}
 */
export async function sendAlert(url, title, body, level = 'info') {
	const cooldownMs = ALERT_COOLDOWN_MS[level];
	if (cooldownMs) {
		const cooldownKey = `${level}:${title}`;
		const lastSent = alertCooldowns.get(cooldownKey) || 0;
		const now = Date.now();
		if (now - lastSent < cooldownMs) {
			return { ok: true, skipped: true, reason: 'rate-limited' };
		}
		alertCooldowns.set(cooldownKey, now);
	}

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
