/**
 * V6 验证策略 — JS 移植版 (PR5: 自适应规模)
 *
 * 历史参数 (V6 验证, 已禁):
 *   - 5% 跌幅触发首买 $30
 *   - 1-5x 加码（跌得越多买越多）
 *   - 月度上限 $500U
 *   - 6 窗口平均收益 +27.8% / 平均回撤 -0.8%
 *
 * PR4 (2026-06-08): sell staircase 关闭 — V7 backtest 6 窗口 sell 贡献 -12.8%
 *   decide() 用 cfg.sellTriggerBase > 0 作为 guard, 三个 0 让阶梯计算短路成空数组.
 *   manual_sell 走 applySell(state, usdt, sol, price, -1), stairIdx=-1 = manual.
 *
 * PR5 (2026-06-08): 5% 自适应 + 4 safeguards
 *   - baseAmount / monthLimit 从绝对美元数改成余额百分比 (5% + 5%, SDA 什一同构)
 *   - minBuyAbsolute $5 防 dust, maxBuyPct 25% 防一次买光
 *   - 4 个护栏 (SAFEGUARD_CONFIG):
 *     1. maxLossPct -30% 触发 isStarted=false (TickerHub 实现, strategy 提供配置)
 *     2. minBalance $30 触发 decide() hold
 *     3. circuitBreakerFails 3 触发 isPaused=true (TickerHub executeBuy/Sell 实现)
 *     4. sweepCloseDust 0.0001 触发 close_round (TickerHub applySell 路径实现)
 *   - 全是 pause-only, 不自动卖, 不自动重启
 *
 * Source: validate-v5.mjs (runDynamicDCA) + validate-adaptive.mjs (5% 自适应验证)
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
 * @property {number|null} [currentRoundId] PR5: dca_rounds.id 当前活跃 round (init_dca 写, close_round 清)
 * @property {number} [peakValue] PR5: maxLossPct 护栏用, 用余额 + 持仓×价算总值, peak = max(peakValue, currentValue)
 * @property {number} [consecutiveFailures] PR5: circuit_breaker 护栏用, buy/sell 异常累加, 成功重置
 */

/**
 * @typedef {Object} TickerSnapshot
 * @property {number} last
 * @property {number} open24h
 * @property {number} ts
 */

/**
 * PR5: 策略层配置 — 自适应供应率 + 单笔保护
 *
 * supplyRates.base = 0.05: 建仓率 (5% × 当前余额 = 首买金额)
 * supplyRates.monthly = 0.05: 月供率 (5% × 当前余额 = 月度投入上限)
 *   SDA 什一奉献同构 — 固定 5% 投入, 跟账户规模自适应
 *   小账户不被过度杠杆, 大账户不被过度保守
 *
 * minBuyAbsolute = $5: OKX 最小单笔约束, 防 dust
 * maxBuyPct = 0.25: 单笔不超过余额 1/4, 防 50% 跌幅触发 5x 加码时把余额买光
 *   (5x × 5% = 25% 刚好等于 maxBuyPct, 实测不触发 clamp, 留作未来 baseRate 调整的安全网)
 */
export const STRATEGY_CONFIG = {
	id: 'adaptive_5pct_v1',
	// PR5: 自适应供应率 (SDA 什一同构 — 余额百分比, 不是绝对美元数)
	supplyRates: {
		base: 0.05, // 建仓率 — 5% × 当前余额
		monthly: 0.05 // 月供率 — 5% × 当前余额 (月度上限)
	},
	// PR5: 单笔保护 (OKX 最小 + 防一次买光)
	minBuyAbsolute: 5, // $5 OKX 最小单笔
	maxBuyPct: 0.25, // 25% 余额 / 单笔
	triggerPct: 5, // 5% 跌幅触发 DCA (跟 V5 E 一致)
	multiplierTiers: [
		{ minDrop: 5, multiplier: 1 },
		{ minDrop: 10, multiplier: 2 },
		{ minDrop: 20, multiplier: 3 },
		{ minDrop: 30, multiplier: 4 },
		{ minDrop: 50, multiplier: 5 }
	],
	initialUSDT: 0, // 默认本金基准 = 0; 实际余额由 syncBalanceFromOkx 从 OKX 真实账户拉
	// PR4 (2026-06-08): sell staircase 关闭 — V7 backtest -12.8% 贡献, User 决定彻底关掉
	sellTriggerBase: 0,
	sellPct: 0,
	stairCount: 0
};

/**
 * PR5: 4 个护栏配置 (pause-only, no auto-sell, no auto-restart)
 *
 * 1. maxLossPct = -0.30: 峰值回撤 30% 触发 isStarted=false
 *    例: peakValue=$1000, currentValue=$700 → (700-1000)/1000 = -30% 触发
 *    跟 V7+ 2021-11 跌 95% 场景对比: 触到时已经 -30%, 给 user 心理缓冲
 *    触到后: isStarted=false (策略层关闭), 持仓保留 (user 手动 manual_sell 决定)
 *
 * 2. minBalance = $30: 余额 < $30 触发 decide() 返回 hold
 *    5% × $600 = $30, 跟 $300 月供 1/10 同步, 防 dust
 *    触到后: decide() 返 hold, buyAmount=0, sendAlert warn
 *    跟 maxBuyPct 互补: maxBuyPct 防单笔过大, minBalance 防余额过小
 *
 * 3. circuitBreakerFails = 3: 连续 3 次 OKX API 失败触发 isPaused=true
 *    计数: executeBuy/executeSell catch 累加, 成功重置 0
 *    触到后: isPaused=true, sendAlert critical, 需 user 手动调 resume
 *
 * 4. sweepCloseDust = 0.0001: applySell/manual_sell 后 solHolding < 0.0001 触发 close_round
 *    行为: 调 closeDcaRound(currentRoundId, { closeReason: 'manual_sell_all' })
 *         → 重置 portfolio (lastBuyPrice=null, avgBuyPrice=null, sellStairsTriggered=Set)
 *         → 持仓 solHolding/usdtBalance 保留 (sell 已关, 不需要清仓)
 *         → isStarted=false, sendAlert info "Round closed automatically"
 */
export const SAFEGUARD_CONFIG = {
	maxLossPct: -0.30, // 峰值回撤 30% 触发 isStarted=false
	minBalance: 30, // $30 USDT 余额下限, decide 返 hold
	circuitBreakerFails: 3, // 连续失败 3 次触发 isPaused=true
	sweepCloseDust: 0.0001 // SOL 持仓 < 0.0001 触发 sweep close round
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
 * PR5: 计算当前余额下的动态供应率值
 *   - baseAmount: 5% × usdtBalance (建仓基准)
 *   - monthLimit: 5% × usdtBalance (月供上限)
 *   - maxBuyByPct: 25% × usdtBalance (单笔上限)
 *
 * @param {PortfolioState} state
 * @param {STRATEGY_CONFIG} [cfg]
 * @returns {{baseAmount: number, monthLimit: number, maxBuyByPct: number, minBuyAbsolute: number}}
 */
export function computeBuyAmount(state, cfg = STRATEGY_CONFIG) {
	const balance = state?.usdtBalance ?? 0;
	const baseAmount = balance * cfg.supplyRates.base;
	const monthLimit = balance * cfg.supplyRates.monthly;
	const maxBuyByPct = balance * cfg.maxBuyPct;
	return {
		baseAmount,
		monthLimit,
		maxBuyByPct,
		minBuyAbsolute: cfg.minBuyAbsolute
	};
}

/**
 * PR5: clamp buyAmount 到 [minBuyAbsolute, maxBuyByPct, balance] 区间
 *   - 低于 minBuyAbsolute → 视为 dust, 返 0 (跳过本次 buy)
 *   - 高于 maxBuyByPct → 缩到 maxBuyByPct (防一次买光)
 *   - 高于 balance → 缩到 balance (防负余额)
 *
 * @param {number} amount 原始买入金额
 * @param {number} balance 可用 USDT 余额
 * @param {{maxBuyPct: number, minBuyAbsolute: number}} limits
 * @returns {number} clamp 后的买入金额, 0 表示跳过
 */
export function clampBuyAmount(amount, balance, limits) {
	const maxBuyByPct = balance * limits.maxBuyPct;
	const cap = Math.min(balance, maxBuyByPct);
	if (amount > cap) amount = cap;
	if (amount < limits.minBuyAbsolute) return 0; // dust skip
	if (amount > balance) amount = balance;
	return amount;
}

/**
 * 生成阶梯比例数组（V6 buildStairRatios — PR4 关闭, 留作未来参考）
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
 * 检查分批回本触发（V6 checkSellStairs — PR4 关闭）
 * @param {PortfolioState} state
 * @param {number} currentPrice
 * @param {ReturnType<typeof buildStairRatios>} stairRatios
 * @param {number} sellPct
 */
export function checkSellStairs(state, currentPrice, stairRatios, sellPct) {
	if (state.solHolding < 0.001) return null;
	if (state.avgBuyPrice == null) return null;
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

	// PR5 (2026-06-08): min_balance 护栏 (sg_min_balance) — pause-only, no auto-sell
	//   余额低于阈值 → decide 返 hold, buyAmount=0, 不实际关策略 (isStarted 不动)
	//   触到后 sendAlert 'warn' 让 user 知道要充值
	if (state.usdtBalance < SAFEGUARD_CONFIG.minBalance) {
		return {
			action: 'hold',
			reason: `余额不足 $${state.usdtBalance.toFixed(2)} < $${SAFEGUARD_CONFIG.minBalance} 阈值 (sg_min_balance)`,
			drawdownPct: null,
			multiplier: 1
		};
	}

	// PR4 (2026-06-08): sell staircase 关闭 guard — V7 backtest 6 窗口 -12.8% 贡献,
	//   User 决定彻底关掉. sellTriggerBase=0 时短路 checkSellStairs 调用,
	//   省 CPU + 保证不会写入 sell 信号. manual_sell 不走这条路径 (UI 直接调 applySell).
	let sellInfo = null;
	if (cfg.sellTriggerBase > 0) {
		const stairRatios = buildStairRatios(cfg.sellTriggerBase, cfg.stairCount);
		sellInfo = checkSellStairs(state, ticker.last, stairRatios, cfg.sellPct);
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

	// PR5: 自适应供应率 — baseAmount / monthLimit 动态从 usdtBalance × supplyRates 算
	//   旧逻辑: cfg.baseAmount (写死 $30) / cfg.monthLimit (写死 $500)
	//   新逻辑: 余额 $7000 → baseAmount=$350, monthLimit=$350 (跟账户规模自适应)
	const { baseAmount, monthLimit } = computeBuyAmount(state, cfg);

	if (drawdownPct >= cfg.triggerPct) {
		// 触发: 算加码倍数 + 月度上限
		const mult = getMultiplier(drawdownPct, cfg.multiplierTiers);
		buyAmount = baseAmount * mult;
		const spent = state.monthSpent.get(todayMonthKey) || 0;
		if (spent + buyAmount > monthLimit) {
			holdReason = `月度上限已满 (本月已用 $${spent.toFixed(0)} / $${monthLimit.toFixed(0)})`;
			buyAmount = 0;
		}
	} else {
		// 跌幅不够 — 最常见的 hold 情况
		holdReason = `跌幅不足 (${drawdownPct.toFixed(2)}% < ${cfg.triggerPct}%)`;
	}

	// PR5: clamp buyAmount 到 [minBuyAbsolute, maxBuyPct, balance] 区间
	if (buyAmount > 0) {
		const clamped = clampBuyAmount(buyAmount, state.usdtBalance, {
			maxBuyPct: cfg.maxBuyPct,
			minBuyAbsolute: cfg.minBuyAbsolute
		});
		if (clamped === 0) {
			// dust skip — 计算金额低于 $5 最小单笔
			holdReason = `dust skip ($${buyAmount.toFixed(2)} < $${cfg.minBuyAbsolute} minBuyAbsolute)`;
			buyAmount = 0;
		} else if (clamped < buyAmount) {
			buyAmount = clamped;
		}
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
 *
 * PR5: peakPrice 持续跟踪 (applyBuy + onOkxTicker 两路更新)
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
 *
 * PR4 (2026-06-08): stairIdx=-1 = manual_sell 标识 (来自 ticker-hub.js 的
 *   manual_sell handler 重构后调用). manual sell 不污染 sellStairsTriggered set,
 *   因为 manual 不属于"分批回本阶梯"的概念 — 只是用户主动减仓. 其他字段
 *   (solHolding/usdtBalance/totalSoldUSDT/realizedPnL/avgBuyPrice) 跟阶梯 sell
 *   行为完全一致, 保证 sweep_close 判定 (< 0.0001 → 清 avgBuyPrice) 通用.
 *
 * PR5: peakPrice 不重置 — sell 后价格继续涨, peakPrice 应该继续更新
 *   (否则丢高水位, 后续 DCA 决策会基于错的基准)
 * @param {PortfolioState} state
 * @param {number} amountUsdt
 * @param {number} amountSol
 * @param {number} price 卖出价
 * @param {number} stairIdx 0..stairCount-1 = 阶梯触发; -1 = manual_sell
 */
export function applySell(state, amountUsdt, amountSol, price, stairIdx) {
	// 截到 4 位 (跟 OKX SOL sz 精度对齐, 跟 truncateSol4 helper 一致); clamp 到 0 防止负数
	state.solHolding = Math.max(0, Math.floor((state.solHolding - amountSol) * 10000) / 10000);
	state.usdtBalance += amountUsdt;
	state.totalSoldUSDT = (state.totalSoldUSDT || 0) + amountUsdt;
	// PR4: manual_sell (stairIdx===-1) 不写入 sellStairsTriggered — manual 不是阶梯触发,
	//   不应污染阶梯状态 (例: 用户手动卖 50%, 不应影响后续自动阶梯 0/1/2 触发判定).
	if (stairIdx !== -1) {
		state.sellStairsTriggered.add(stairIdx);
	}
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