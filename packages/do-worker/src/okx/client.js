/**
 * OKX V5 API 客户端（HMAC-SHA256 签名）
 *
 * 覆盖：
 * - 下单 POST /api/v5/trade/order
 * - 查账户 GET /api/v5/account/balance
 * - 公共行情 GET /api/v5/market/ticker
 * - Demo 模式：Header `x-simulated-trading: 1`
 *
 * 凭证通过 env 注入（dev: .env，生产: wrangler secret put）
 */

function base64FromBytes(bytes) {
	let binary = '';
	for (let i = 0; i < bytes.byteLength; i++) {
		binary += String.fromCharCode(bytes[i]);
	}
	return btoa(binary);
}

async function hmacSha256(secret, message) {
	const encoder = new TextEncoder();
	const key = await crypto.subtle.importKey(
		'raw',
		encoder.encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign']
	);
	const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
	return base64FromBytes(new Uint8Array(sig));
}

function okxTimestamp() {
	return new Date().toISOString();
}

/**
 * @typedef {Object} OkxCredentials
 * @property {string} apiKey
 * @property {string} apiSecret
 * @property {string} passphrase
 * @property {boolean} isDemo
 */

/**
 * OKX REST 客户端
 */
export class OkxClient {
	/**
	 * @param {OkxCredentials} creds
	 * @param {string} baseUrl
	 */
	constructor(creds, baseUrl = 'https://www.okx.com') {
		this.creds = creds;
		this.baseUrl = baseUrl;
	}

	/**
	 * 私有请求（带 HMAC 签名）
	 * @param {string} method GET / POST
	 * @param {string} path
	 * @param {Object} [body]
	 * @returns {Promise<any>}
	 */
	async privateRequest(method, path, body) {
		const timestamp = okxTimestamp();
		const bodyStr = body ? JSON.stringify(body) : '';
		const message = timestamp + method.toUpperCase() + path + bodyStr;
		const signature = await hmacSha256(this.creds.apiSecret, message);

		const headers = {
			'OK-ACCESS-KEY': this.creds.apiKey,
			'OK-ACCESS-SIGN': signature,
			'OK-ACCESS-TIMESTAMP': timestamp,
			'OK-ACCESS-PASSPHRASE': this.creds.passphrase,
			'Content-Type': 'application/json'
		};
		if (this.creds.isDemo) {
			headers['x-simulated-trading'] = '1';
		}

		const res = await fetch(this.baseUrl + path, {
			method,
			headers,
			body: bodyStr || undefined
		});
		const json = await res.json();
		if (json.code !== '0') {
			throw new Error(
				`OKX API error: ${json.msg} (code=${json.code}, data=${JSON.stringify(json.data)})`
			);
		}
		return json.data;
	}

	/**
	 * 公共请求（无需签名）
	 * @param {string} path
	 * @param {Object} [params]
	 * @returns {Promise<any>}
	 */
	async publicRequest(path, params) {
		let url = this.baseUrl + path;
		if (params) {
			const qs = new URLSearchParams(params).toString();
			url += `?${qs}`;
		}
		const res = await fetch(url);
		const json = await res.json();
		if (json.code !== '0') {
			throw new Error(`OKX public API error: ${json.msg}`);
		}
		return json.data;
	}

	/**
	 * 下市价买单（按 USDT 金额）
	 * @param {string} instId
	 * @param {number} amountUsdt
	 * @param {string} clOrdId
	 * @param {number} [lastPrice] 可选:已知的最新价格, 用它算 sz 跳过额外 /api/v5/market/ticker call
	 *   (省 ~50ms, 接受微小滑点, market order 本来就接受)
	 */
	async marketBuy(instId, amountUsdt, clOrdId, lastPrice = null) {
		let price = lastPrice;
		if (price == null) {
			const ticker = await this.publicRequest('/api/v5/market/ticker', { instId });
			price = parseFloat(ticker[0].last);
		}
		// OKX V5 spot market buy: sz 是 quote 币 (USDT) 数量, tgtCcy=quote_ccy 显式声明
		// 不传 tgtCcy 时 OKX demo 实际把它当 quote 处理, 但官方文档说 default base_ccy
		// — 显式写 quote_ccy 避免歧义
		const sz = amountUsdt.toFixed(2);
		return this.privateRequest('POST', '/api/v5/trade/order', {
			instId,
			tdMode: 'cash',
			side: 'buy',
			ordType: 'market',
			tgtCcy: 'quote_ccy',
			sz,
			clOrdId
		});
	}

	/**
	 * 查订单详情 — 拿真实 fill 数据 (accFillSz, avgPx, fillSz, fee)
	 * 用途: executeBuy/executeSell 下单后, trade 表不再写预算值, 用真实 fill 覆盖
	 * @param {string} instId e.g. 'SOL-USDT'
	 * @param {string} ordId OKX 订单 ID
	 * @returns {Promise<Object|null>} OKX 订单对象, null if not found
	 */
	async getOrderDetail(instId, ordId) {
		const data = await this.privateRequest('GET', `/api/v5/trade/order?ordId=${encodeURIComponent(ordId)}&instId=${encodeURIComponent(instId)}`);
		return data?.[0] || null;
	}

	/**
	 * 下市价卖单（按币数量）
	 * @param {string} instId
	 * @param {number} amountSol
	 * @param {string} clOrdId
	 */
	async marketSell(instId, amountSol, clOrdId) {
		return this.privateRequest('POST', '/api/v5/trade/order', {
			instId,
			tdMode: 'cash',
			side: 'sell',
			ordType: 'market',
			sz: amountSol.toFixed(4),
			clOrdId
		});
	}

	/**
	 * 查账户余额（原始）
	 */
	async getBalance() {
		return this.privateRequest('GET', '/api/v5/account/balance');
	}

	/**
	 * 查 USDT 余额
	 * OKX V5 /api/v5/account/balance 返回: data = [{ details: [{ ccy, availBal, ... }] }]
	 * ccy 列表在 details 数组里, 不是 data 数组
	 */
	async getUsdtBalance() {
		const data = await this.getBalance();
		for (const account of data) {
			const entry = account.details?.find((d) => d.ccy === 'USDT');
			if (entry) return parseFloat(entry.availBal);
		}
		return 0;
	}

	/**
	 * 查 SOL 余额
	 */
	async getSolBalance() {
		const data = await this.getBalance();
		for (const account of data) {
			const entry = account.details?.find((d) => d.ccy === 'SOL');
			if (entry) return parseFloat(entry.availBal);
		}
		return 0;
	}
}

/**
 * OKX 凭证缺失错误 — 比 "Imported HMAC key length (0)" 更友好
 */
export class OkxCredentialsMissingError extends Error {
	constructor(missingKeys) {
		super(
			`OKX credentials missing: ${missingKeys.join(', ')} — ` +
				`put via 'wrangler secret put' (remote) or write to do-worker/.dev.vars (local)`
		);
		this.name = 'OkxCredentialsMissingError';
		this.missingKeys = missingKeys;
	}
}

/**
 * 探测 env 里 OKX 凭证是否齐全（不抛错，只返回缺失 key 列表）
 * @param {any} env
 * @param {boolean} [forceMode] 可选 — 强制 demo / live, 跳过 env OKX_DEMO_MODE 检查
 * @returns {string[]} missing env var names (empty = OK)
 */
export function checkOkxCredentials(env, forceMode) {
	const isDemo = forceMode != null ? forceMode : env.OKX_DEMO_MODE !== '0';
	const missing = [];
	if (isDemo) {
		if (!env.OKX_DEMO_API_KEY) missing.push('OKX_DEMO_API_KEY');
		if (!env.OKX_DEMO_API_SECRET) missing.push('OKX_DEMO_API_SECRET');
		if (!env.OKX_DEMO_PASSPHRASE) missing.push('OKX_DEMO_PASSPHRASE');
	} else {
		if (!env.OKX_LIVE_API_KEY) missing.push('OKX_LIVE_API_KEY');
		if (!env.OKX_LIVE_API_SECRET) missing.push('OKX_LIVE_API_SECRET');
		if (!env.OKX_LIVE_PASSPHRASE) missing.push('OKX_LIVE_PASSPHRASE');
	}
	return missing;
}

/**
 * 从 platform.env 构造 OKX client
 *
 * OKX 模拟盘和实盘是**两套独立 API key**（同一个 OKX 账号下分别申请）。
 * 切换 mode 时（OKX_DEMO_MODE = 0 或 1），代码自动选对应那套。
 *
 * 注入规则：
 * - Phase 1（Demo）：先 put 3 个 demo secret
 * - Phase 2（Live）：先 put 3 个 live secret，再改 OKX_DEMO_MODE=0，redeploy
 *
 * 注意：这里不 throw 缺凭证错误，让 TickerHub 决定怎么处理（避免 DO 构造函数挂掉）
 * 调用方应该在调 buy/sell 前用 checkOkxCredentials() 探一下
 *
 * @param {any} env
 * @param {boolean} [forceMode] 可选 — 强制 demo / live, 跳过 OKX_DEMO_MODE env 检查
 *   用于 demo / live 两个 DO instance 各自拿对应那套 credentials
 */
export function createOkxClient(env, forceMode) {
	const isDemo = forceMode != null ? forceMode : env.OKX_DEMO_MODE !== '0';
	const creds = isDemo
		? {
				apiKey: env.OKX_DEMO_API_KEY || '',
				apiSecret: env.OKX_DEMO_API_SECRET || '',
				passphrase: env.OKX_DEMO_PASSPHRASE || ''
			}
		: {
				apiKey: env.OKX_LIVE_API_KEY || '',
				apiSecret: env.OKX_LIVE_API_SECRET || '',
				passphrase: env.OKX_LIVE_PASSPHRASE || ''
			};
	return new OkxClient(
		{ ...creds, isDemo },
		env.OKX_API_BASE || 'https://www.okx.com'
	);
}
