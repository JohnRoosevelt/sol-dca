// SOL DCA 验证 V8+: 5% 自适应 (baseAmount/monthLimit = usdtBalance ×5%) × 6 窗口
// 跟 /tmp/verifier-v5-adaptive/result.json ADAPTIVE_5PCT 行数对照
//   6 窗口平均 return ≈ +115% (baseline +115.1%, ±5%)
//   6 窗口平均 MDD ≈ -5% (baseline -4.7%, ±2%)
//
// 公式:
//   baseAmount  = usdtBalance × 0.05
//   monthLimit  = usdtBalance × 0.05 (跟 baseAmount 同步, 单笔 + 月度都跟余额走)
//   minBuyAbsolute = $5 (OKX 最小单笔, 防 dust)
//   maxBuyPct   = 25% (防 50% 跌幅触发 5x 加码时把余额买光)
//
// 触发: 5% 跌幅 (跟 V5 E 一致)
// 加码: 5%/1x, 10%/2x, 20%/3x, 30%/4x, 50%/5x
//
// V6/V7 baseline: 5%/1x × $30 base × $500 monthLimit = E 策略 (无 sell), 6 窗口 +29.9%
// V8 baseline:    5%/1-5x × $30 base × $500 monthLimit = E 策略, 6 窗口 +27.8% (含阶梯 sell)
// V8 自适应:      5%/1-5x × 5% balance × 5% balance monthLimit = 自适应 (无 sell)

const BASE_URL = 'https://www.okx.com/api/v5/market/history-candles';
const INST_ID = 'SOL-USDT';
const BAR = '1D';
const LIMIT = 100;

const WINDOWS = [
	{ id: 'w2025', label: '2025-06 牛尾入场', start: '2025-06-20', evalDate: '2026-04-20' },
	{ id: 'w2024', label: '2024-06 震荡市', start: '2024-06-20', evalDate: '2025-04-20' },
	{ id: 'w2023', label: '2023-06 熊末反转', start: '2023-06-20', evalDate: '2024-04-20' },
	{ id: 'w2022', label: '2022-06 熊市深跌', start: '2022-06-20', evalDate: '2023-04-20' },
	{ id: 'w2021', label: '2021-06 牛市中部', start: '2021-06-20', evalDate: '2022-04-20' },
	{ id: 'w_long', label: '2020-06 6年长窗口', start: '2020-06-20', evalDate: '2026-06-06' }
];

async function fetchKLines(after = null) {
	const url = after
		? `${BASE_URL}?instId=${INST_ID}&bar=${BAR}&after=${after}&limit=${LIMIT}`
		: `${BASE_URL}?instId=${INST_ID}&bar=${BAR}&limit=${LIMIT}`;
	const res = await fetch(url);
	const json = await res.json();
	if (json.code !== '0') throw new Error(`OKX API error: ${json.msg}`);
	return json.data;
}

async function fetchAllKLines(startTs) {
	const all = [];
	let after = null;
	let safety = 0;
	while (safety < 30) {
		const data = await fetchKLines(after);
		if (!data || data.length === 0) break;
		all.push(...data);
		const oldestTs = parseInt(data[data.length - 1][0]);
		if (oldestTs <= startTs) break;
		after = oldestTs;
		safety++;
		await new Promise(r => setTimeout(r, 200));
	}
	return all
		.map(k => ({
			ts: parseInt(k[0]),
			open: parseFloat(k[1]),
			high: parseFloat(k[2]),
			low: parseFloat(k[3]),
			close: parseFloat(k[4]),
			date: new Date(parseInt(k[0])).toISOString().slice(0, 10)
		}))
		.sort((a, b) => a.ts - b.ts);
}

function getMultiplier(dropPct, tiers) {
	if (!tiers || tiers.length === 0) return 1;
	let m = 1;
	for (const t of tiers) {
		if (dropPct >= t.minDrop) m = t.multiplier;
	}
	return m;
}

/**
 * PR5: 5% 自适应 DCA — baseAmount/monthLimit 动态从 usdtBalance × supplyRates 算
 * @param {Array} klines
 * @param {Object} strategy { initialUSDT, baseRate, monthlyRate, triggerPct, multiplierTiers, minBuyAbsolute, maxBuyPct }
 * @param {string} start YYYY-MM-DD
 * @param {string} evalDate YYYY-MM-DD
 */
function runAdaptive5pct(klines, strategy, start, evalDate) {
	const events = [];
	let usdt = strategy.initialUSDT;
	let sol = 0;
	let lastBuyPrice = null;
	let buyCount = 0;
	let totalSpent = 0;
	let maxDrawdown = 0;
	let peakValue = strategy.initialUSDT;
	let firstBuyDate = null;
	const monthSpent = {};

	for (const k of klines) {
		if (k.date < start) continue;
		if (k.date > evalDate) break;

		// PR5: 动态供应率
		const baseAmount = usdt * strategy.baseRate;
		const monthLimit = usdt * strategy.monthlyRate;
		const maxBuyByPct = usdt * strategy.maxBuyPct;

		// 触发判断
		let buyAmount = 0;
		let triggerDropPct = null;

		if (lastBuyPrice === null) {
			// 冷启动首买 = baseAmount (5% × 余额)
			buyAmount = baseAmount;
		} else {
			const dropPct = ((lastBuyPrice - k.close) / lastBuyPrice) * 100;
			if (dropPct >= strategy.triggerPct) {
				triggerDropPct = dropPct;
				const mult = getMultiplier(dropPct, strategy.multiplierTiers);
				buyAmount = baseAmount * mult;
				// 月度上限
				const monthKey = k.date.slice(0, 7);
				const spent = monthSpent[monthKey] || 0;
				if (spent + buyAmount > monthLimit) {
					buyAmount = monthLimit - spent;
				}
				if (buyAmount <= 0) buyAmount = 0;
			}
		}

		// PR5: clamp buyAmount 到 [minBuyAbsolute, maxBuyByPct, usdt]
		if (buyAmount > 0) {
			// 上限: maxBuyByPct
			if (buyAmount > maxBuyByPct) buyAmount = maxBuyByPct;
			// 下限: minBuyAbsolute
			if (buyAmount < strategy.minBuyAbsolute) buyAmount = 0; // dust skip
			// 余额
			if (buyAmount > usdt) buyAmount = usdt;
		}

		if (buyAmount < 1) continue;

		const solBought = buyAmount / k.close;
		usdt -= buyAmount;
		sol += solBought;
		lastBuyPrice = k.close;
		buyCount++;
		totalSpent += buyAmount;
		if (firstBuyDate === null) firstBuyDate = k.date;
		const monthKey = k.date.slice(0, 7);
		monthSpent[monthKey] = (monthSpent[monthKey] || 0) + buyAmount;

		// MDD tracking
		const currentValue = usdt + sol * k.close;
		if (currentValue > peakValue) peakValue = currentValue;
		const dd = (currentValue - peakValue) / peakValue;
		if (dd < maxDrawdown) maxDrawdown = dd;

		events.push({
			date: k.date,
			type: 'BUY',
			price: k.close,
			usdtSpent: buyAmount,
			solBought,
			triggerDropPct,
			monthKey
		});

		if (usdt < 1) {
			events.push({ date: k.date, type: 'EXHAUSTED', note: '余额耗尽' });
			break;
		}
	}

	const evalK =
		klines.filter(kk => kk.date <= evalDate).sort((a, b) => b.ts - a.ts)[0] ||
		klines[klines.length - 1];
	const finalPrice = evalK.close;
	const finalValue = sol * finalPrice + usdt;
	const finalProfit = finalValue - strategy.initialUSDT;
	const totalReturnPct = (finalProfit / strategy.initialUSDT) * 100;
	const monthsActive = firstBuyDate
		? Math.max(1, Math.round((new Date(evalDate) - new Date(firstBuyDate)) / (30 * 86400000)))
		: 0;
	return {
		finalPrice,
		buyCount,
		totalSpent,
		usdtRemaining: usdt,
		solHolding: sol,
		currentSolValue: sol * finalPrice,
		finalValue,
		finalProfit,
		totalReturnPct,
		maxDrawdown: maxDrawdown * 100,
		monthsActive,
		events: events.slice(0, 30)
	};
}

async function main() {
	console.log('🚀 SOL DCA 验证 V8+ 5% 自适应 — 6 窗口');
	console.log('   baseAmount = usdtBalance × 5%, monthLimit = usdtBalance × 5%');
	console.log('   minBuyAbsolute = $5, maxBuyPct = 25%, triggerPct = 5%, multiplierTiers = [5/1, 10/2, 20/3, 30/4, 50/5]');
	console.log('');

	const startTs = new Date('2020-06-01').getTime();
	console.log('📊 拉取 OKX SOL/USDT 6 年 K 线...');
	const klines = await fetchAllKLines(startTs);
	console.log(`   ✓ ${klines.length} 天, ${klines[0].date} → ${klines[klines.length - 1].date}`);
	console.log(`   ✓ 价区间: $${Math.min(...klines.map(k => k.low)).toFixed(2)} - $${Math.max(...klines.map(k => k.high)).toFixed(2)}`);
	console.log('');

	const strategy = {
		id: 'ADAPTIVE_5PCT',
		label: '5% 自适应 (PR5)',
		baseRate: 0.05,
		monthlyRate: 0.05,
		triggerPct: 5,
		multiplierTiers: [
			{ minDrop: 5, multiplier: 1 },
			{ minDrop: 10, multiplier: 2 },
			{ minDrop: 20, multiplier: 3 },
			{ minDrop: 30, multiplier: 4 },
			{ minDrop: 50, multiplier: 5 }
		],
		minBuyAbsolute: 5,
		maxBuyPct: 0.25,
		initialUSDT: 7000
	};

	const results = [];
	for (const w of WINDOWS) {
		try {
			const r = runAdaptive5pct(klines, strategy, w.start, w.evalDate);
			r.window = w.id;
			r.windowLabel = w.label;
			r.start = w.start;
			r.evalDate = w.evalDate;
			results.push(r);
			const sign = r.finalProfit >= 0 ? '+' : '';
			console.log(
				`   ${w.label.padEnd(25)} 期末 $${r.finalPrice.toFixed(2).padStart(7)} | 收益 ${sign}${r.totalReturnPct.toFixed(2).padStart(7)}% | 买 ${String(r.buyCount).padStart(3)} | 回撤 ${r.maxDrawdown.toFixed(1)}%`
			);
		} catch (e) {
			console.log(`   ${w.label.padEnd(25)} ❌ ${e.message}`);
		}
	}

	const avgReturn = results.reduce((a, b) => a + b.totalReturnPct, 0) / results.length;
	const avgMDD = results.reduce((a, b) => a + b.maxDrawdown, 0) / results.length;
	const worstReturn = Math.min(...results.map(x => x.totalReturnPct));
	const bestReturn = Math.max(...results.map(x => x.totalReturnPct));

	console.log('');
	console.log('═══════════════════════════════════════════════════════════════════════════');
	console.log(`📊 6 窗口汇总 (跟 /tmp/verifier-v5-adaptive/result.json ADAPTIVE_5PCT 对照)`);
	console.log('═══════════════════════════════════════════════════════════════════════════');
	console.log(`   6 窗口平均收益: ${avgReturn >= 0 ? '+' : ''}${avgReturn.toFixed(2)}%   (baseline +115.1%, ±5% tolerance)`);
	console.log(`   6 窗口平均回撤: ${avgMDD.toFixed(2)}%  (baseline -4.7%, ±2% tolerance)`);
	console.log(`   最差窗口收益: ${worstReturn >= 0 ? '+' : ''}${worstReturn.toFixed(2)}%`);
	console.log(`   最佳窗口收益: +${bestReturn.toFixed(2)}%`);
	console.log('');

	const resultJson = {
		generatedAt: new Date().toISOString(),
		strategy,
		windows: WINDOWS,
		klinesLength: klines.length,
		klinesDateRange: [klines[0].date, klines[klines.length - 1].date],
		results,
		summary: {
			avgReturnPct: avgReturn,
			avgMDD: avgMDD,
			worstReturnPct: worstReturn,
			bestReturnPct: bestReturn,
			baselineAvgReturnPct: 115.1,
			baselineAvgMDD: -4.7,
			returnDiffPct: avgReturn - 115.1,
			mddDiffPct: avgMDD - -4.7,
			withinTolerance: Math.abs(avgReturn - 115.1) <= 5 && Math.abs(avgMDD - -4.7) <= 2
		}
	};

	const fs = await import('fs');
	const outPath = '/Users/josh.zhu/.mavis/plans/plan_e586f547/outputs/pr5-adaptive-safeguards-rounds/validate-adaptive-result.json';
	fs.writeFileSync(outPath, JSON.stringify(resultJson, null, 2));
	console.log(`✅ 结果已写入 ${outPath}`);

	// 与 baseline 对照 — 硬约束 (return ±5%, MDD ±2%)
	const returnOk = Math.abs(avgReturn - 115.1) <= 5;
	const mddOk = Math.abs(avgMDD - -4.7) <= 2;
	console.log('');
	console.log('═══════════════════════════════════════════════════════════════════════════');
	console.log('🎯 硬约束 vs baseline (return ±5%, MDD ±2%):');
	console.log(`   avg return ${avgReturn.toFixed(2)}% vs +115.1% → ${returnOk ? '✅ PASS' : '❌ FAIL'} (diff: ${(avgReturn - 115.1).toFixed(2)}%)`);
	console.log(`   avg MDD ${avgMDD.toFixed(2)}% vs -4.7% → ${mddOk ? '✅ PASS' : '❌ FAIL'} (diff: ${(avgMDD - -4.7).toFixed(2)}%)`);
	console.log('═══════════════════════════════════════════════════════════════════════════');

	if (!returnOk || !mddOk) {
		process.exit(1);
	}
}

main().catch(err => {
	console.error('❌ V8+ Validation failed:', err);
	process.exit(1);
});