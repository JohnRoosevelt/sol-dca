/**
 * V6 验证策略 — JS 移植版
 *
 * 锁定参数：E_d5p_5x + r0.5_s0.3_n3
 * - 5% 跌幅触发首买 $30
 * - 1-5x 加码（跌得越多买越多）
 * - 月度上限 $500U
 * - 分批回本：+50%/+100%/+150% 各卖 30%（累计 90%，留 10% 底仓）
 * - 6 窗口平均收益 +27.8% / 平均回撤 -0.8%
 *
 * Source: validate-v6.mjs (runEWithSellParams + checkSellStairsV6)
 */

/**
 * @typedef {Object} PortfolioState
 * @property {number} usdtBalance
 * @property {number} solHolding
 * @property {number|null} lastBuyPrice
 * @property {number} totalSpent
 * @property {number} [totalSoldUSDT]
 * @property {number} consecutiveDcaBuys
 * @property {string|null} currentMonthReset
 * @property {Map<string, number>} monthSpent
 * @property {Set<number>} sellStairsTriggered
 */

/**
 * @typedef {Object} TickerSnapshot
 * @property {number} last
 * @property {number} open24h
 * @property {number} ts
 */

export const STRATEGY_CONFIG = {
	id: 'E_d5p_5x_r0.5_s0.3_n3',
	baseAmount: 30,
	triggerPct: 5,
	monthLimit: 500,
	multiplierTiers: [
		{ minDrop: 5, multiplier: 1 },
		{ minDrop: 10, multiplier: 2 },
		{ minDrop: 20, multiplier: 3 },
		{ minDrop: 30, multiplier: 4 },
		{ minDrop: 50, multiplier: 5 }
	],
	initialUSDT: 7000,
	sellTriggerBase: 0.5,
	sellPct: 0.3,
	stairCount: 3
};

/**
 * 计算加码倍数（V6 验证逻辑）
 * @param {number} dropPct 从 lastBuyPrice 跌的百分比
 * @param {Array<{minDrop: number, multiplier: number}>} tiers
 * @returns {number}
 */
export function getMultiplier(dropPct, tiers) {
	if (!tiers || tiers.length === 0) return 1;
	let m = 1;
	for (const t of tiers) {
		if (dropPct >= t.minDrop) m = t.multiplier;
	}
	return m;
}

/**
 * 生成阶梯比例数组（V6 buildStairRatios）
 * @param {number} base triggerBase
 * @param {number} count stairCount
 * @returns {number[]}
 */
export function buildStairRatios(base, count) {
	if (count === 3) return [base, base * 2, base * 3];
	if (count === 5) return [base, base * 1.5, base * 2, base * 3, base * 5];
	return [base];
}

/**
 * 检查分批回本触发（V6 checkSellStairsV6）
 * @param {PortfolioState} state
 * @param {number} currentPrice
 * @param {ReturnType<typeof buildStairRatios>} stairRatios
 * @param {number} sellPct
 * @returns {null | { stairIdx: number, profit: number, triggerProfit: number, ratio: number }}
 */
export function checkSellStairs(state, currentPrice, stairRatios, sellPct) {
	if (state.solHolding < 0.001) return null;
	const currentValue = state.usdtBalance + state.solHolding * currentPrice;
	const profit = currentValue - state.totalSpent;
	for (let i = 0; i < stairRatios.length; i++) {
		if (state.sellStairsTriggered.has(i)) continue;
		const triggerProfit = state.totalSpent * stairRatios[i];
		if (profit >= triggerProfit && state.totalSpent > 0) {
			return { stairIdx: i, profit, triggerProfit, ratio: stairRatios[i] };
		}
	}
	return null;
}

/**
 * 主决策函数 — 每个 ticker 推送调用一次
 * @param {TickerSnapshot} ticker
 * @param {PortfolioState} state
 * @param {string} todayMonthKey YYYY-MM
 * @returns {null | { action: 'buy' | 'sell' | 'hold' | 'skip', reason: string, amountUsdt?: number, amountSol?: number, drawdownPct?: number | null, multiplier?: number, profitPct?: number, stairIdx?: number, sellPct?: number }}
 */
export function decide(ticker, state, todayMonthKey) {
	const cfg = STRATEGY_CONFIG;
	const stairRatios = buildStairRatios(cfg.sellTriggerBase, cfg.stairCount);

	// 1) 分批回本检查（先卖后买 — V6 顺序）
	const sellInfo = checkSellStairs(state, ticker.last, stairRatios, cfg.sellPct);
	if (sellInfo) {
		const sellSol = state.solHolding * cfg.sellPct;
		const sellUsdt = sellSol * ticker.last;
		const profitPct = (sellInfo.profit / Math.max(state.totalSpent, 1)) * 100;
		return {
			action: 'sell',
			reason: `浮盈 +${profitPct.toFixed(0)}% ≥ +${(sellInfo.ratio * 100).toFixed(0)}%（r=${sellInfo.ratio.toFixed(1)}），卖 ${(cfg.sellPct * 100).toFixed(0)}%`,
			amountSol: sellSol,
			amountUsdt: sellUsdt,
			profitPct,
			stairIdx: sellInfo.stairIdx,
			sellPct: cfg.sellPct
		};
	}

	// 2) DCA 触发判断
	let buyAmount = 0;
	let drawdownPct = null;
	if (state.lastBuyPrice === null) {
		// 冷启动:不动手，等用户显式"Start DCA"建立基准价
		return {
			action: 'hold',
			reason: '等待首次买入触发(点 UI 上"Start DCA"按钮建立基准价)',
			drawdownPct: null,
			multiplier: 1
		};
	} else {
		drawdownPct = ((state.lastBuyPrice - ticker.last) / state.lastBuyPrice) * 100;
		if (drawdownPct >= cfg.triggerPct) {
			const mult = getMultiplier(drawdownPct, cfg.multiplierTiers);
			buyAmount = cfg.baseAmount * mult;
			const spent = state.monthSpent.get(todayMonthKey) || 0;
			if (spent + buyAmount > cfg.monthLimit) {
				buyAmount = cfg.monthLimit - spent;
			}
			if (buyAmount <= 0) buyAmount = 0;
		}
	}

	if (buyAmount > state.usdtBalance) buyAmount = state.usdtBalance;
	if (buyAmount < 1) {
		return { action: 'hold', reason: '未触发 + 余额不足' };
	}

	return {
		action: 'buy',
		reason: drawdownPct
			? `跌 ${drawdownPct.toFixed(1)}% 触发，买 $${buyAmount.toFixed(0)}`
			: `首买 $${buyAmount.toFixed(0)}`,
		amountUsdt: buyAmount,
		drawdownPct,
		multiplier: drawdownPct ? getMultiplier(drawdownPct, cfg.multiplierTiers) : 1
	};
}

/**
 * 月度重置检查 — 跨月时清零
 * @param {PortfolioState} state
 * @param {string} todayMonthKey YYYY-MM
 * @returns {boolean} 是否刚跨月（已重置）
 */
export function maybeResetMonth(state, todayMonthKey) {
	if (state.currentMonthReset === todayMonthKey) return false;
	state.currentMonthReset = todayMonthKey;
	state.monthSpent = new Map();
	return true;
}

/**
 * 应用 buy 后的状态变更（in-memory）
 * @param {PortfolioState} state
 * @param {number} amountUsdt
 * @param {number} amountSol
 * @param {number} price
 * @param {string} todayMonthKey
 */
export function applyBuy(state, amountUsdt, amountSol, price, todayMonthKey) {
	state.usdtBalance -= amountUsdt;
	state.solHolding += amountSol;
	state.lastBuyPrice = price;
	state.totalSpent += amountUsdt;
	state.consecutiveDcaBuys++;
	state.monthSpent.set(todayMonthKey, (state.monthSpent.get(todayMonthKey) || 0) + amountUsdt);
}

/**
 * 应用 sell 后的状态变更（in-memory）
 * @param {PortfolioState} state
 * @param {number} amountUsdt
 * @param {number} amountSol
 * @param {number} stairIdx
 */
export function applySell(state, amountUsdt, amountSol, stairIdx) {
	state.solHolding -= amountSol;
	state.usdtBalance += amountUsdt;
	state.totalSoldUSDT = (state.totalSoldUSDT || 0) + amountUsdt;
	state.sellStairsTriggered.add(stairIdx);
	state.consecutiveDcaBuys = 0;
}
