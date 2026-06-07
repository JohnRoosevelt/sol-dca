/**
 * OKX Public WebSocket 客户端
 *
 * OKX 文档: https://www.okx.com/docs-v5/log_zh/
 * Ticker 推送: wss://ws.okx.com:8443/ws/v5/public
 * Subscribe:    { "op": "subscribe", "args": [{"channel":"tickers","instId":"SOL-USDT"}] }
 *
 * 接收 ticker data 数组，单元素: { instId, last, open24h, high24h, low24h, ts, ... }
 *
 * 设计：纯函数式，外部持有 WebSocket 引用，自己处理 ping / pong
 */

const PING_INTERVAL_MS = 25_000; // OKX 要求 30s 内 ping，我们 25s

/**
 * @typedef {Object} TickerData
 * @property {string} instId
 * @property {string} last
 * @property {string} open24h
 * @property {string} high24h
 * @property {string} low24h
 * @property {string} ts
 */

/**
 * @typedef {Object} TickerHandlers
 * @property {(data: TickerData) => void} onTicker
 * @property {(err: Error) => void} onError
 * @property {() => void} onOpen
 * @property {(code: number, reason: string) => void} onClose
 */

/**
 * 打开 OKX public WS 订阅 ticker
 * @param {string} url wss://ws.okx.com:8443/ws/v5/public
 * @param {string} channel 形如 tickers
 * @param {string} instId 形如 SOL-USDT
 * @param {TickerHandlers} handlers
 * @returns {{ ws: WebSocket, pingTimer: ReturnType<typeof setInterval>, close: () => void }}
 */
export function subscribeTicker(url, channel, instId, handlers) {
	const ws = new WebSocket(url);
	let pingTimer = null;
	let closed = false;

	const close = () => {
		if (closed) return;
		closed = true;
		clearInterval(pingTimer);
		try {
			ws.close(1000, 'client_close');
		} catch (_) {}
	};

	ws.addEventListener('open', () => {
		handlers.onOpen?.();
		// Subscribe
		ws.send(
			JSON.stringify({
				op: 'subscribe',
				args: [{ channel, instId }]
			})
		);
		// 启 ping
		pingTimer = setInterval(() => {
			if (ws.readyState === WebSocket.OPEN) {
				ws.send('ping');
			}
		}, PING_INTERVAL_MS);
	});

	ws.addEventListener('message', (event) => {
		const text = typeof event.data === 'string' ? event.data : '';
		if (text === 'pong') return;

		try {
			const msg = JSON.parse(text);
			// 忽略 subscribe 响应 / 错误
			if (msg.event) return;
			if (msg.arg?.channel !== channel) return;
			if (Array.isArray(msg.data) && msg.data.length > 0) {
				for (const d of msg.data) {
					handlers.onTicker(d);
				}
			}
		} catch (err) {
			handlers.onError?.(new Error(`OKX WS parse failed: ${err.message}`));
		}
	});

	ws.addEventListener('error', (event) => {
		handlers.onError?.(new Error(`OKX WS error: ${event.message || 'unknown'}`));
	});

	ws.addEventListener('close', (event) => {
		clearInterval(pingTimer);
		handlers.onClose?.(event.code, event.reason || '');
	});

	return { ws, pingTimer, close };
}
