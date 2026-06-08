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
 * @property {number|null} avgBuyPrice 加权平均买入价 (没持仓/null)
 * @property {number} realizedPnL 累计已实现盈亏 (分批回本 + 手动卖出)
 * @property {number|null} lastBuyPrice 最近一笔买入价 (lastBuyPrice 跟 avgBuyPrice 不同)
 * @property {number|null} peakPrice 建仓以来的最高价 (P0-2 fix: 高位建仓后用 peak 算 drawdown, 不漏 DCA)
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
	initialUSDT: 0, // 默认本金基准 = 0; 实际余额由 syncBalanceFromOkx 从 OKX 真实账户拉, 不假设
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
 * 浮盈 = (现价 - 平均买入价) × 持仓数 — 不包含 usdt 余额, 不包含已实现 P&L
 *   (已实现 P&L 是历史行为, 不再触发新 sell — sell stair 是基于"未实现浮盈"的概念)
 * @param {PortfolioState} state
 * @param {number} currentPrice
 * @param {ReturnType<typeof buildStairRatios>} stairRatios
 * @param {number} sellPct
 * @returns {null | { stairIdx: number, profit: number, triggerProfit: number, ratio: number }}
 */
export function checkSellStairs(state, currentPrice, stairRatios, sellPct) {
	if (state.solHolding < 0.001) return null;
	if (state.avgBuyPrice == null) return null; // 冷启动守卫: 没平均买入价不算 profit
	// 浮盈 = (currentPrice - avgBuyPrice) * solHolding
	const profit = (currentPrice - state.avgBuyPrice) * state.solHolding;
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
	if (state.lastBuyPrice === null) {
		// 冷启动:不动手，等用户显式"Start DCA"建立基准价
		return {
			action: 'hold',
			reason: '等待首次买入触发(点 UI 上"启动 V6"按钮建基准价)',
			drawdownPct: null,
			multiplier: 1
		};
	}

	// P0-2: 跌幅参考价用 peakPrice (建仓以来最高), 不是 lastBuyPrice
	//   高位建仓后熊市初期, lastBuyPrice 已接近 peak, 用 lastBuyPrice 算跌幅可能不到 5%, 漏 DCA
	//   例: peak=100, lastBuyPrice=95 (建仓后小跌 5%), tick.last=91
	//       新 (peak): (100-91)/100 = 9% 触发 5% DCA ✓
	//       旧 (last): (95-91)/95 = 4.2% < 5% 漏掉 DCA — 这就是 P0-2 bug
	//   冷启动: peakPrice=null, fallback 到 lastBuyPrice (跟旧逻辑等价)
	const refPrice = state.peakPrice ?? state.lastBuyPrice;
	const drawdownPct = ((refPrice - ticker.last) / refPrice) * 100;
	let buyAmount = 0;
	let holdReason = null;

	if (drawdownPct >= cfg.triggerPct) {
		// 触发: 算加码倍数 + 月度上限
		const mult = getMultiplier(drawdownPct, cfg.multiplierTiers);
		buyAmount = cfg.baseAmount * mult;
		const spent = state.monthSpent.get(todayMonthKey) || 0;
		if (spent + buyAmount > cfg.monthLimit) {
			holdReason = `月度上限已满 (本月已用 $${spent.toFixed(0)} / $${cfg.monthLimit})`;
			buyAmount = 0;
		}
	} else {
		// 跌幅不够 — 最常见的 hold 情况
		holdReason = `跌幅不足 (${drawdownPct.toFixed(2)}% < ${cfg.triggerPct}%)`;
	}

	// 余额检查 (在触发之后)
	if (buyAmount > state.usdtBalance && buyAmount > 0) {
		holdReason = `余额不足 (需 $${buyAmount.toFixed(0)} > 余额 $${state.usdtBalance.toFixed(2)})`;
		buyAmount = state.usdtBalance;
	}
	if (buyAmount < 1) {
		return {
			action: 'hold',
			reason: holdReason ?? '未触发 (买入额 < $1)',
			drawdownPct,
			multiplier: drawdownPct >= cfg.triggerPct ? getMultiplier(drawdownPct, cfg.multiplierTiers) : 1
		};
	}

	return {
		action: 'buy',
		reason: `跌 ${drawdownPct.toFixed(1)}% 触发，买 $${buyAmount.toFixed(0)}`,
		amountUsdt: buyAmount,
		drawdownPct,
		multiplier: getMultiplier(drawdownPct, cfg.multiplierTiers)
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
 * 加权平均价公式: newAvg = (oldAvg * oldQty + newPrice * newQty) / (oldQty + newQty)
 *   第一次买: avgBuyPrice = price (冷启动)
 *   P0-2: peakPrice = max(peakPrice ?? 0, price) — 高位建仓后熊市初期用 peak 算 drawdown, 不漏 DCA
 * @param {PortfolioState} state
 * @param {number} amountUsdt
 * @param {number} amountSol
 * @param {number} price
 * @param {string} todayMonthKey
 */
export function applyBuy(state, amountUsdt, amountSol, price, todayMonthKey) {
	state.usdtBalance -= amountUsdt;
	// 截到 6 位，防止 OKX 精度(8位) vs DO state 累积误差
	state.solHolding = Math.max(0, Math.floor((state.solHolding + amountSol) * 1000000) / 1000000);
	state.lastBuyPrice = price;
	// P0-2: 跟踪建仓以来最高价 — decide() 用它算 drawdownPct 而不是 lastBuyPrice
	//   peakPrice 只增不减 (熊市不重置), 所以建仓后涨到更高再跌也能正确算跌
	state.peakPrice = Math.max(state.peakPrice ?? 0, price);
	// 加权平均价 — 含历史持仓成本
	if (state.avgBuyPrice == null || state.solHolding - amountSol < 0.0001) {
		// 冷启动 / 之前已清仓: 以本次价格作 avg
		state.avgBuyPrice = price;
	} else {
		const oldCost = state.avgBuyPrice * (state.solHolding - amountSol);
		const newCost = price * amountSol;
		state.avgBuyPrice = (oldCost + newCost) / state.solHolding;
	}
	state.totalSpent += amountUsdt;
	state.consecutiveDcaBuys++;
	state.monthSpent.set(todayMonthKey, (state.monthSpent.get(todayMonthKey) || 0) + amountUsdt);
}

/**
 * 应用 sell 后的状态变更（in-memory）
 * 累加 realizedPnL = (sellPrice - avgBuyPrice) * amountSol (按本次卖出的成本基础)
 * 卖光 (solHolding < dust) 时清 avgBuyPrice — 重新开始累计
 * @param {PortfolioState} state
 * @param {number} amountUsdt
 * @param {number} amountSol
 * @param {number} price 卖出价
 * @param {number} stairIdx
 */
export function applySell(state, amountUsdt, amountSol, price, stairIdx) {
	// 截到 6 位，防止精度漂移累积；clamp 到 0 防止负数
	state.solHolding = Math.max(0, Math.floor((state.solHolding - amountSol) * 1000000) / 1000000);
	state.usdtBalance += amountUsdt;
	state.totalSoldUSDT = (state.totalSoldUSDT || 0) + amountUsdt;
	state.sellStairsTriggered.add(stairIdx);
	state.consecutiveDcaBuys = 0;
	// 累加已实现盈亏
	if (state.avgBuyPrice != null) {
		state.realizedPnL = (state.realizedPnL || 0) + (price - state.avgBuyPrice) * amountSol;
	}
	// 卖光 (剩 dust) → 清 avgBuyPrice, 下次买入以新价作 avg
	if (state.solHolding < 0.0001) {
		state.avgBuyPrice = null;
	}
}
