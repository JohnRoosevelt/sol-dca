import { WS_URL, TOTP_SECRET } from '$lib/config.js';
import { syncBalance, sendControl, reset, fetchSignals, fetchTrades } from '$lib/api/client.js';
import { createReconnectManager, RECONNECT_CIRCUIT_BREAKER } from '$lib/utils/reconnect.svelte';
import { isWithinGrace, markTotpVerified, TOTP_VERIFIED_KEY, GRACE_MS } from '$lib/stores/totp.svelte';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface InitialDashboardState {
	mode?: string;
	portfolio?: any;
	paused?: boolean;
	okxWsState?: string;
	lastTickerPrice?: number;
	lastTickerAt?: string;
	missingCredentials?: string[];
	sabbath?: boolean;
}

// ---------------------------------------------------------------------------
// Store factory
// ---------------------------------------------------------------------------

export function createDashboardStore(initial: InitialDashboardState = {}) {
	// === Mode: demo / live (localStorage > SSR initial > fallback) ===
	const VALID_MODES = ['demo', 'live'];
	function loadMode() {
		if (typeof window !== 'undefined') {
			const ls = localStorage.getItem('sol-dca-mode');
			if (VALID_MODES.includes(ls)) return ls;
		}
		if (VALID_MODES.includes(initial.mode)) return initial.mode;
		return 'demo';
	}

	// --- $state ---
	let portfolio = $state(initial.portfolio ?? null);
	let paused = $state(initial.paused ?? false);
	let okxWsState = $state(initial.okxWsState ?? 'init');
	let lastTickerPrice = $state(initial.lastTickerPrice ?? 0);
	let lastTickerAt = $state(initial.lastTickerAt ?? 0);
	let missingCredentials = $state(initial.missingCredentials ?? []);
	let sabbath = $state(initial.sabbath ?? false);
	let connected = $state(false);
	let wsState = $state('connecting'); // connecting | open | closed | error
	let recentSignals = $state([]);
	let recentTrades = $state([]);
	let historyEntries = $state([]);
	let historyFilter = $state('all');
	let historyLoading = $state(false);
	let mode = $state(loadMode());
	let starting = $state(false);
	let firstBuying = $state(false);
	let resetting = $state(false);
	let refreshing = $state(false);
	let showTotpModal = $state(false);
	let pendingMode = $state(null);
	let lastError = $state(null);

	// PR-WS-reconnect state — delegated to createReconnectManager
	let reconnectAttempts = $state(0);
	let reconnectStopped = $state(false);

	// --- WS instance (module-level — not reactive, just a ref) ---
	let ws = null;
	let reconnectTimer = null;
	let heartbeatTimer = null;

	// --- Error auto-clear timer ---
	let _errorTimer;

	// --- Reconnect manager (delegates to createReconnectManager to avoid duplicate state) ---
	const reconnectMgr = createReconnectManager({
		onScheduleReconnect(delay, attempts) {
			reconnectAttempts = attempts;
			if (reconnectTimer) clearTimeout(reconnectTimer);
			console.log(`[dashboard] reconnect attempt ${attempts}/${RECONNECT_CIRCUIT_BREAKER} in ${delay / 1000}s`);
			reconnectTimer = setTimeout(connect, delay);
		},
		onCircuitBreaker() {
			reconnectStopped = true;
			wsState = 'error';
			setError(
				`WS 重连失败 ${RECONNECT_CIRCUIT_BREAKER} 次 (可能 DO quota 触顶). ` +
					`点 [重连] 按钮手动恢复, 或刷新页面`
			);
			console.warn(`[dashboard] circuit breaker tripped after ${reconnectAttempts} attempts`);
		}
	});

	// --- $derived ---
	let controlInFlight = $derived(starting || resetting);
	let needsInit = $derived(
		portfolio != null && portfolio.lastBuyPrice == null && portfolio.isStarted !== true
	);
	let needsFirstBuy = $derived(
		portfolio != null && portfolio.lastBuyPrice == null && portfolio.isStarted === true
	);
	let suggestedFirstBuy = $derived.by(() => {
		if (!portfolio) return 0;
		const balance = portfolio.usdtBalance ?? 0;
		return Math.max(0, balance * 0.05);
	});
	let monthBudgetMax = $derived.by(() => {
		if (!portfolio) return 0;
		const balance = portfolio.usdtBalance ?? 0;
		return Math.max(0, balance * 0.05);
	});
	let visibleSignals = $derived(recentSignals.filter((s) => s.action !== 'hold'));
	let holdCount = $derived(recentSignals.length - visibleSignals.length);
	let tickerTimeText = $derived(
		lastTickerAt ? new Date(lastTickerAt).toLocaleTimeString() : ''
	);
	let tickerAgeSec = $derived(
		lastTickerAt ? Math.max(0, Math.floor((Date.now() - Number(lastTickerAt)) / 1000)) : -1
	);
	let liveCurrentValue = $derived.by(() => {
		if (!portfolio) return 0;
		return portfolio.usdtBalance + (portfolio.solHolding ?? 0) * lastTickerPrice;
	});
	let liveUnrealizedPnL = $derived.by(() => {
		if (!portfolio || portfolio.avgBuyPrice == null || (portfolio.solHolding ?? 0) <= 0.0001) return 0;
		return (lastTickerPrice - portfolio.avgBuyPrice) * portfolio.solHolding;
	});
	let liveProfit = $derived.by(() => {
		if (!portfolio) return 0;
		return liveUnrealizedPnL + (portfolio.realizedPnL ?? 0);
	});
	let liveProfitPct = $derived.by(() => {
		if (
			!portfolio ||
			portfolio.avgBuyPrice == null ||
			portfolio.avgBuyPrice <= 0 ||
			(portfolio.solHolding ?? 0) <= 0.0001
		)
			return 0;
		return ((lastTickerPrice - portfolio.avgBuyPrice) / portfolio.avgBuyPrice) * 100;
	});
	let filteredHistory = $derived.by(() => {
		if (historyFilter === 'all') return historyEntries;
		if (historyFilter === 'signal') return historyEntries.filter((e) => e._type === 'signal' && e.action !== 'hold');
		if (historyFilter === 'trade') return historyEntries.filter((e) => e._type === 'trade');
		if (historyFilter === 'hold') return historyEntries.filter((e) => e._type === 'signal' && e.action === 'hold');
		return historyEntries;
	});

	const HISTORY_LIMIT = 200;

	// ---------------------------------------------------------------------------
	// Error helpers
	// ---------------------------------------------------------------------------
	function setError(msg) {
		lastError = msg;
		clearTimeout(_errorTimer);
		_errorTimer = setTimeout(() => { lastError = null; }, 10_000);
	}
	function clearError() {
		lastError = null;
		clearTimeout(_errorTimer);
	}

	// ---------------------------------------------------------------------------
	// Reconnect logic — delegated to reconnectMgr (createReconnectManager)
	// ---------------------------------------------------------------------------

	// ---------------------------------------------------------------------------
	// WebSocket connect
	// ---------------------------------------------------------------------------
	function connect() {
		if (typeof window === 'undefined') return;
		if (reconnectStopped) return;
		const sep = WS_URL.includes('?') ? '&' : '?';
		const url = `${WS_URL}${sep}mode=${mode}`;
		wsState = 'connecting';
		try {
			ws = new WebSocket(url);
		} catch (err) {
			console.error('[dashboard] WebSocket construct failed:', err);
			wsState = 'error';
			setError(`WebSocket 构造失败: ${err.message}`);
			reconnectMgr.scheduleReconnect();
			return;
		}

		ws.onopen = () => {
			wsState = 'open';
			connected = true;
			reconnectMgr.manualReconnect();
		};

		ws.onmessage = (e) => {
			try {
				const msg = JSON.parse(e.data);
				handle(msg);
			} catch (err) {
				console.error('[dashboard] parse failed:', err);
			}
		};

		ws.onerror = () => {
			wsState = 'error';
			setError('WebSocket error');
		};

		ws.onclose = () => {
			wsState = 'closed';
			connected = false;
			reconnectMgr.scheduleReconnect();
		};
	}

	// ---------------------------------------------------------------------------
	// Message handler
	// ---------------------------------------------------------------------------
	function handle(msg) {
		switch (msg.type) {
			case 'hello':
				portfolio = msg.portfolio;
				paused = msg.paused;
				okxWsState = msg.okxWsState;
				lastTickerPrice = msg.lastTickerPrice;
				lastTickerAt = msg.lastTickerAt ?? 0;
				if (Array.isArray(msg.recentSignals)) recentSignals = msg.recentSignals;
				if (Array.isArray(msg.recentTrades)) recentTrades = msg.recentTrades;
				missingCredentials = msg.missingCredentials ?? [];
				break;
			case 'ticker':
				lastTickerPrice = msg.price;
				if (msg.ts) lastTickerAt = msg.ts;
				break;
			case 'signal':
				recentSignals = [msg, ...recentSignals].slice(0, 50);
				historyEntries = [
					{ ...msg, _type: 'signal', _key: 's_' + (msg.id || Date.now() + '_' + Math.random()) },
					...historyEntries
				].slice(0, HISTORY_LIMIT);
				break;
			case 'trade':
				recentTrades = [msg, ...recentTrades].slice(0, 50);
				historyEntries = [
					{
						...msg,
						amount_usdt: msg.amountUsdt ?? msg.amount_usdt,
						amount_sol: msg.amountSol ?? msg.amount_sol,
						_type: 'trade',
						_key: 't_' + (msg.id || Date.now() + '_' + Math.random()),
						created_at: msg.created_at ?? new Date().toISOString()
					},
					...historyEntries
				].slice(0, HISTORY_LIMIT);
				break;
			case 'paused':
				paused = msg.paused;
				break;
			case 'portfolio_synced':
				if (msg.portfolio) portfolio = msg.portfolio;
				break;
			case 'portfolio_reset':
				portfolio = msg.portfolio;
				recentSignals = [];
				recentTrades = [];
				break;
			case 'error':
				setError(msg.message);
				break;
		}
	}

	// ---------------------------------------------------------------------------
	// TOTP helpers
	// ---------------------------------------------------------------------------
	function confirmTotpAndSwitch(target) {
		showTotpModal = false;
		pendingMode = null;
		markTotpVerified();
		if (target !== 'live') return;
		performModeSwitch(target);
	}

	// ---------------------------------------------------------------------------
	// Mode switch
	// ---------------------------------------------------------------------------
	function switchMode(target) {
		if (!VALID_MODES.includes(target)) return;
		if (target === mode) return;
		if (target === 'live') {
			const secret = TOTP_SECRET;
			if (secret && isWithinGrace()) {
				pendingMode = null;
				performModeSwitch(target);
				return;
			}
			if (!secret) {
				console.warn('[switchMode] TOTP_SECRET not configured, skipping 2FA');
			}
			pendingMode = 'live';
			showTotpModal = true;
			return;
		}
		performModeSwitch(target);
	}

	function performModeSwitch(target) {
		mode = target;
		if (typeof window !== 'undefined') {
			localStorage.setItem('sol-dca-mode', target);
			document.cookie = `sol-dca-mode=${target}; path=/; max-age=31536000; SameSite=Lax`;
		}
		if (ws) {
			ws.onclose = null;
			try { ws.close(); } catch (_) {}
			ws = null;
		}
		if (reconnectTimer) {
			clearTimeout(reconnectTimer);
			reconnectTimer = null;
		}
		reconnectAttempts = 0;
		reconnectStopped = false;
		reconnectMgr.manualReconnect();
		portfolio = null;
		paused = false;
		okxWsState = 'init';
		lastTickerPrice = 0;
		lastTickerAt = 0;
		recentSignals = [];
		recentTrades = [];
		historyEntries = [];
		historyFilter = 'all';
		clearError();
		connect();
		fetchState();
		loadHistory();
	}

	// ---------------------------------------------------------------------------
	// API calls
	// ---------------------------------------------------------------------------
	async function fetchState() {
		const result = await syncBalance(mode);
		if (!result.ok) {
			setError(`state ${mode} failed: ${result.error}`);
			return;
		}
		portfolio = result.portfolio;
		paused = result.paused ?? false;
		okxWsState = result.okxWsState ?? 'init';
		lastTickerPrice = result.lastTickerPrice ?? 0;
		lastTickerAt = result.lastTickerAt ?? 0;
		missingCredentials = result.missingCredentials ?? [];
		if (Array.isArray(result.recentSignals)) recentSignals = result.recentSignals;
		if (Array.isArray(result.recentTrades)) recentTrades = result.recentTrades;
	}

	async function doSendControl(action, extra = {}) {
		const result = await sendControl(mode, action, extra);
		if (!result.ok) {
			const detail = result.data?.error ? `: ${result.data.error}` : '';
			setError(`control ${action} failed${detail}`);
		} else {
			clearError();
		}
		return result;
	}

	async function refreshBalance() {
		if (refreshing) return;
		refreshing = true;
		try {
			await fetchState();
			await new Promise((r) => setTimeout(r, 2000));
			if (refreshing) {
				await fetchState();
			}
		} finally {
			refreshing = false;
		}
	}

	async function startDca() {
		if (starting || missingCredentials.length > 0) return;
		starting = true;
		try {
			await doSendControl('init_dca');
			await fetchState();
		} catch (err) {
			setError(`start failed: ${err}`);
		} finally {
			starting = false;
		}
	}

	async function doFirstBuy() {
		if (firstBuying || missingCredentials.length > 0) return;
		firstBuying = true;
		try {
			const result = await doSendControl('manual_buy');
			if (!result.ok || !result.data?.ok) {
				setError(`first buy failed: ${result.data?.error ?? 'unknown'}`);
			}
			await fetchState();
		} catch (err) {
			setError(`first buy failed: ${err}`);
		} finally {
			firstBuying = false;
		}
	}

	async function doReset() {
		if (resetting || missingCredentials.length > 0) return;
		if (
			!confirm(
				'确认清空 + 卖光所有 SOL?\n\n' +
					'- 尝试卖光持仓 SOL 换 USDT (OKX 失败也强制清空 portfolio)\n' +
					'- 清空所有 trades / signals / 历史\n' +
					'- 重新拉 OKX 真实账户 USDT 余额\n' +
					'- V6 监控从零开始 (需重新点"启动 V6"建基准价)'
			)
		)
			return;
		resetting = true;
		try {
			const result = await reset(mode);
			if (!result.ok) {
				setError(`reset failed: ${result.error}`);
				return;
			}
			if (result.portfolio) {
				portfolio = result.portfolio;
			} else {
				await fetchState();
			}
		} catch (err) {
			setError(`reset error: ${err}`);
		} finally {
			resetting = false;
		}
	}

	async function loadHistory() {
		historyLoading = true;
		try {
			const [sResult, tResult] = await Promise.all([
				fetchSignals(mode, 200),
				fetchTrades(mode, 100)
			]);
			const sEntries = (sResult.signals || []).map((s) => ({
				_type: 'signal',
				_key: 's_' + s.id,
				created_at: s.created_at,
				action: s.action,
				price: s.price,
				reason: s.reason,
				drawdown_pct: s.drawdown_pct,
				profit_pct: s.profit_pct
			}));
			const tEntries = (tResult.trades || []).map((t) => ({
				_type: 'trade',
				_key: 't_' + t.id,
				created_at: t.created_at,
				action: t.side,
				side: t.side,
				price: t.price,
				amount_usdt: t.amount_usdt,
				amount_sol: t.amount_sol,
				reason: t.reason
			}));
			historyEntries = [...sEntries, ...tEntries]
				.sort((a, b) => +new Date(String(b.created_at)) - +new Date(String(a.created_at)))
				.slice(0, HISTORY_LIMIT);
		} catch (err) {
			console.error('loadHistory failed:', err);
		} finally {
			historyLoading = false;
		}
	}

	// ---------------------------------------------------------------------------
	// Heartbeat (to be called from onMount in the component)
	// ---------------------------------------------------------------------------
	function startHeartbeat() {
		stopHeartbeat();
		heartbeatTimer = setInterval(() => {
			if (ws?.readyState === WebSocket.OPEN) {
				ws.send(JSON.stringify({ type: 'ping' }));
			}
		}, 30_000);
	}

	function stopHeartbeat() {
		if (heartbeatTimer) {
			clearInterval(heartbeatTimer);
			heartbeatTimer = null;
		}
	}

	// ---------------------------------------------------------------------------
	// Cleanup (to be called from onDestroy in the component)
	// ---------------------------------------------------------------------------
	function cleanup() {
		stopHeartbeat();
		if (reconnectTimer) {
			clearTimeout(reconnectTimer);
			reconnectTimer = null;
		}
		if (ws) {
			ws.onclose = null;
			ws.close();
			ws = null;
		}
	}

	// ---------------------------------------------------------------------------
	// Return the store instance
	// ---------------------------------------------------------------------------
	return {
		// --- $state (exposed as getters so callers can $derived them) ---
		get portfolio() { return portfolio; },
		get paused() { return paused; },
		get okxWsState() { return okxWsState; },
		get lastTickerPrice() { return lastTickerPrice; },
		get lastTickerAt() { return lastTickerAt; },
		get missingCredentials() { return missingCredentials; },
		get sabbath() { return sabbath; },
		get connected() { return connected; },
		get wsState() { return wsState; },
		get recentSignals() { return recentSignals; },
		get recentTrades() { return recentTrades; },
		get historyEntries() { return historyEntries; },
		get historyFilter() { return historyFilter; },
		get historyLoading() { return historyLoading; },
		get mode() { return mode; },
		get starting() { return starting; },
		get firstBuying() { return firstBuying; },
		get resetting() { return resetting; },
		get refreshing() { return refreshing; },
		get showTotpModal() { return showTotpModal; },
		get pendingMode() { return pendingMode; },
		get lastError() { return lastError; },
		get reconnectAttempts() { return reconnectAttempts; },
		get reconnectStopped() { return reconnectStopped; },
		get visibleSignals() { return visibleSignals; },
		get holdCount() { return holdCount; },
		get needsInit() { return needsInit; },
		get needsFirstBuy() { return needsFirstBuy; },
		get suggestedFirstBuy() { return suggestedFirstBuy; },
		get monthBudgetMax() { return monthBudgetMax; },
		get tickerTimeText() { return tickerTimeText; },
		get tickerAgeSec() { return tickerAgeSec; },
		get liveCurrentValue() { return liveCurrentValue; },
		get liveUnrealizedPnL() { return liveUnrealizedPnL; },
		get liveProfit() { return liveProfit; },
		get liveProfitPct() { return liveProfitPct; },
		get filteredHistory() { return filteredHistory; },
		get controlInFlight() { return controlInFlight; },

		// --- setters (for two-way binding in component) ---
		set historyFilter(v) { historyFilter = v; },

		// --- methods ---
		connect,
		manualReconnect() {
			reconnectAttempts = 0;
			reconnectStopped = false;
			reconnectMgr.manualReconnect();
			if (reconnectTimer) {
				clearTimeout(reconnectTimer);
				reconnectTimer = null;
			}
			clearError();
			connect();
		},
		switchMode,
		performModeSwitch,
		fetchState,
		sendControl: doSendControl,
		refreshBalance,
		startDca,
		doFirstBuy,
		doReset,
		loadHistory,
		setError,
		clearError,
		handle,
		confirmTotpAndSwitch,

		// --- lifecycle (called from component onMount/onDestroy) ---
		startHeartbeat,
		cleanup
	};
}
