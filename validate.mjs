// SOL DCA 验证 V4 — 动态 DCA + 价格触发 + 投到没钱
// 6 策略 × 6 窗口 = 36 个回测组合

const BASE_URL = 'https://www.okx.com/api/v5/market/history-candles';
const INST_ID = 'SOL-USDT';
const BAR = '1D';
const LIMIT = 100;

// === 6 个策略 ===
const STRATEGIES = [
  { id: 'A_fix200', label: 'A. 固定 $200/月', type: 'fixed', perMonth: 200, initialUSDT: 7000 },
  { id: 'B_fix300', label: 'B. 固定 $300/月', type: 'fixed', perMonth: 300, initialUSDT: 7000 },
  { id: 'C_d5p_300', label: 'C. 5% 触发/$30U/次/月$300U', type: 'dynamic',
    baseAmount: 30, triggerPct: 5, monthLimit: 300, multiplierTiers: [], initialUSDT: 7000 },
  { id: 'D_d10p_300', label: 'D. 10% 触发/$30U/次/月$300U', type: 'dynamic',
    baseAmount: 30, triggerPct: 10, monthLimit: 300, multiplierTiers: [], initialUSDT: 7000 },
  { id: 'E_d5p_5x', label: 'E. 5% 触发+1-5x加码/月$500U（推荐）', type: 'dynamic',
    baseAmount: 30, triggerPct: 5, monthLimit: 500,
    multiplierTiers: [
      { minDrop: 5,  multiplier: 1 },
      { minDrop: 10, multiplier: 2 },
      { minDrop: 20, multiplier: 3 },
      { minDrop: 30, multiplier: 4 },
      { minDrop: 50, multiplier: 5 },
    ],
    initialUSDT: 7000 },
  { id: 'F_d10p_5x', label: 'F. 10% 触发+1-5x加码/月$1000U（激进）', type: 'dynamic',
    baseAmount: 30, triggerPct: 10, monthLimit: 1000,
    multiplierTiers: [
      { minDrop: 10, multiplier: 1 },
      { minDrop: 20, multiplier: 2 },
      { minDrop: 30, multiplier: 3 },
      { minDrop: 50, multiplier: 4 },
      { minDrop: 70, multiplier: 5 },
    ],
    initialUSDT: 7000 },
];

// === 6 个起点窗口 ===
const WINDOWS = [
  { id: 'w2025', label: '2025-06 牛尾入场', start: '2025-06-20', evalDate: '2026-04-20' },
  { id: 'w2024', label: '2024-06 震荡市',   start: '2024-06-20', evalDate: '2025-04-20' },
  { id: 'w2023', label: '2023-06 熊末反转', start: '2023-06-20', evalDate: '2024-04-20' },
  { id: 'w2022', label: '2022-06 熊市深跌', start: '2022-06-20', evalDate: '2023-04-20' },
  { id: 'w2021', label: '2021-06 牛市中部', start: '2021-06-20', evalDate: '2022-04-20' },
  { id: 'w_long', label: '2020-06 6年长窗口', start: '2020-06-20', evalDate: '2026-06-06' },
];

// === 拉 K 线 ===
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
  return all.map(k => ({
    ts: parseInt(k[0]),
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    date: new Date(parseInt(k[0])).toISOString().slice(0, 10),
  })).sort((a, b) => a.ts - b.ts);
}

function getPriceOnDate(klines, dateStr) {
  const k = klines.find(k => k.date === dateStr);
  if (k) return k;
  const target = new Date(dateStr).getTime();
  const prev = klines.filter(k => k.ts <= target + 86400000).sort((a, b) => b.ts - a.ts)[0];
  if (!prev) throw new Error(`No price data on or before ${dateStr}`);
  return prev;
}

function getMultiplier(dropPct, tiers) {
  if (!tiers || tiers.length === 0) return 1;
  let m = 1;
  for (const t of tiers) {
    if (dropPct >= t.minDrop) m = t.multiplier;
  }
  return m;
}

// === Fixed DCA 模式 ===
function runFixedDCA(klines, strategy, start, evalDate) {
  const events = [];
  let usdt = strategy.initialUSDT;
  let sol = 0;
  let buyCount = 0;
  let totalSpent = 0;
  const monthSpent = {};
  let maxDrawdown = 0;
  let peakValue = strategy.initialUSDT;
  let firstBuyDate = null;

  const startDt = new Date(start);
  const evalDt = new Date(evalDate);
  const cur = new Date(startDt);
  while (cur <= evalDt) {
    const dateStr = cur.toISOString().slice(0, 10);
    let k;
    try { k = getPriceOnDate(klines, dateStr); }
    catch { cur.setMonth(cur.getMonth() + 1); continue; }

    let buyAmount = strategy.perMonth;
    if (buyAmount > usdt) buyAmount = usdt;
    if (buyAmount < 1) { cur.setMonth(cur.getMonth() + 1); continue; }

    const solBought = buyAmount / k.close;
    usdt -= buyAmount;
    sol += solBought;
    buyCount++;
    totalSpent += buyAmount;
    if (firstBuyDate === null) firstBuyDate = dateStr;
    const monthKey = dateStr.slice(0, 7);
    monthSpent[monthKey] = (monthSpent[monthKey] || 0) + buyAmount;

    const currentValue = usdt + sol * k.close;
    if (currentValue > peakValue) peakValue = currentValue;
    const dd = (currentValue - peakValue) / peakValue;
    if (dd < maxDrawdown) maxDrawdown = dd;

    events.push({
      date: dateStr, type: 'BUY', price: k.close, usdtSpent: buyAmount, solBought,
      usdtBalance: usdt, solBalance: sol, monthSpent: monthSpent[monthKey],
      note: `固定 DCA $${buyAmount}`,
    });

    if (usdt < 1) {
      events.push({ date: dateStr, type: 'EXHAUSTED', note: '账户耗尽' });
      break;
    }
    cur.setMonth(cur.getMonth() + 1);
  }
  return finalize(events, usdt, sol, totalSpent, buyCount, firstBuyDate, evalDate, maxDrawdown, klines, strategy);
}

// === Dynamic DCA 模式（价格触发） ===
function runDynamicDCA(klines, strategy, start, evalDate) {
  const events = [];
  let usdt = strategy.initialUSDT;
  let sol = 0;
  let lastBuyPrice = null;
  let buyCount = 0;
  let totalSpent = 0;
  const monthSpent = {};
  let maxDrawdown = 0;
  let peakValue = strategy.initialUSDT;
  let firstBuyDate = null;

  for (const k of klines) {
    if (k.date < start) continue;
    if (k.date > evalDate) break;

    let buyAmount = 0;
    let triggerDropPct = null;

    if (lastBuyPrice === null) {
      buyAmount = strategy.baseAmount;
    } else {
      const dropPct = (lastBuyPrice - k.close) / lastBuyPrice * 100;
      if (dropPct >= strategy.triggerPct) {
        triggerDropPct = dropPct;
        const mult = getMultiplier(dropPct, strategy.multiplierTiers);
        buyAmount = strategy.baseAmount * mult;
        const monthKey = k.date.slice(0, 7);
        const spent = monthSpent[monthKey] || 0;
        if (spent + buyAmount > strategy.monthLimit) {
          buyAmount = strategy.monthLimit - spent;
        }
        if (buyAmount <= 0) buyAmount = 0;
      }
    }

    if (buyAmount > usdt) buyAmount = usdt;
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

    const currentValue = usdt + sol * k.close;
    if (currentValue > peakValue) peakValue = currentValue;
    const dd = (currentValue - peakValue) / peakValue;
    if (dd < maxDrawdown) maxDrawdown = dd;

    events.push({
      date: k.date, type: 'BUY', price: k.close, usdtSpent: buyAmount, solBought,
      usdtBalance: usdt, solBalance: sol, monthSpent: monthSpent[monthKey],
      triggerDropPct,
      note: triggerDropPct
        ? `跌 ${triggerDropPct.toFixed(1)}% 触发，买 $${buyAmount}`
        : `首买 $${buyAmount}`,
    });

    if (usdt < 1) {
      events.push({ date: k.date, type: 'EXHAUSTED', note: '账户耗尽，停止买入' });
      break;
    }
  }
  return finalize(events, usdt, sol, totalSpent, buyCount, firstBuyDate, evalDate, maxDrawdown, klines, strategy);
}

function finalize(events, usdt, sol, totalSpent, buyCount, firstBuyDate, evalDate, maxDrawdown, klines, strategy) {
  const evalK = klines.filter(k => k.date <= evalDate).sort((a, b) => b.ts - a.ts)[0] || klines[klines.length - 1];
  const finalPrice = evalK.close;
  const finalValue = sol * finalPrice + usdt;
  const finalProfit = finalValue - strategy.initialUSDT;
  const totalReturnPct = (finalProfit / strategy.initialUSDT) * 100;
  const avgCost = totalSpent > 0 ? totalSpent / sol : 0;
  const monthsActive = firstBuyDate
    ? Math.max(1, Math.round((new Date(evalDate) - new Date(firstBuyDate)) / (30 * 86400000)))
    : 0;
  const avgPerMonth = monthsActive > 0 ? totalSpent / monthsActive : 0;
  return {
    finalPrice, buyCount, totalSpent, usdtRemaining: usdt, solHolding: sol,
    currentSolValue: sol * finalPrice, finalValue, finalProfit, totalReturnPct,
    maxDrawdown: maxDrawdown * 100, avgCost, monthsActive, avgPerMonth,
    events: events.slice(0, 100),
  };
}

function runBacktest(klines, strategy, start, evalDate) {
  if (strategy.type === 'fixed') return runFixedDCA(klines, strategy, start, evalDate);
  return runDynamicDCA(klines, strategy, start, evalDate);
}

// === 主程序 ===
async function main() {
  console.log('🚀 SOL DCA 验证 V4 — 6 策略 × 6 窗口 = 36 组合');
  console.log('');

  const startTs = new Date('2020-06-01').getTime();
  console.log('📊 拉取 OKX SOL/USDT 6 年 K 线...');
  const klines = await fetchAllKLines(startTs);
  console.log(`   ✓ ${klines.length} 天，${klines[0].date} → ${klines[klines.length - 1].date}`);
  console.log(`   ✓ 价区间: $${Math.min(...klines.map(k => k.low)).toFixed(2)} - $${Math.max(...klines.map(k => k.high)).toFixed(2)}`);
  console.log('');

  console.log('🔄 跑 36 组合回测...');
  const results = [];
  for (const s of STRATEGIES) {
    console.log(`\n📋 ${s.label}`);
    for (const w of WINDOWS) {
      try {
        const r = runBacktest(klines, s, w.start, w.evalDate);
        r.strategy = s.id;
        r.strategyLabel = s.label;
        r.window = w.id;
        r.windowLabel = w.label;
        r.start = w.start;
        r.evalDate = w.evalDate;
        results.push(r);
        const sign = r.finalProfit >= 0 ? '+' : '';
        console.log(`   ${w.label.padEnd(25)} 期末 $${r.finalPrice.toFixed(2).padStart(7)} | 收益 ${sign}${r.totalReturnPct.toFixed(2).padStart(7)}% | 买入 ${String(r.buyCount).padStart(3)} 次 | 最大回撤 ${r.maxDrawdown.toFixed(1)}%`);
      } catch (e) {
        console.log(`   ${w.label.padEnd(25)} ❌ ${e.message}`);
      }
    }
  }

  const fs = await import('fs');
  fs.writeFileSync('./validate-result.json', JSON.stringify({
    generatedAt: new Date().toISOString(),
    priceRange: {
      allTimeLow: Math.min(...klines.map(k => k.low)),
      allTimeHigh: Math.max(...klines.map(k => k.high)),
      currentPrice: klines[klines.length - 1].close,
    },
    strategies: STRATEGIES,
    windows: WINDOWS,
    results,
  }, null, 2));

  // 汇总表 — 平均收益
  console.log('\n');
  console.log('═══════════════════════════════════════════════════════════════════════════════════════════');
  console.log('📊 6 策略 × 6 窗口 — 期末总收益 %');
  console.log('═══════════════════════════════════════════════════════════════════════════════════════════');
  console.log('策略'.padEnd(14) + ' | 2020-06(6年) | 2025-06 | 2024-06 | 2023-06 | 2022-06 | 2021-06 | 平均    ');
  console.log('─────────────────────────────────────────────────────────────────────────────────────────────');
  for (const s of STRATEGIES) {
    const r = results.filter(x => x.strategy === s.id);
    const cells = WINDOWS.map(w => {
      const rr = r.find(x => x.window === w.id);
      if (!rr) return '   N/A  ';
      const sign = rr.totalReturnPct >= 0 ? '+' : '';
      return `${sign}${rr.totalReturnPct.toFixed(1).padStart(5)}%`;
    });
    const avg = r.reduce((a, b) => a + b.totalReturnPct, 0) / r.length;
    const sign = avg >= 0 ? '+' : '';
    console.log(s.id.padEnd(14) + ' | ' + cells.join(' | ') + ' | ' + sign + avg.toFixed(1) + '%');
  }
  console.log('─────────────────────────────────────────────────────────────────────────────────────────────');

  // 汇总表 — 最大回撤
  console.log('\n');
  console.log('═══════════════════════════════════════════════════════════════════════════════════════════');
  console.log('🛡️ 6 策略 × 6 窗口 — 最大回撤 %（负数，越接近 0 越抗跌）');
  console.log('═══════════════════════════════════════════════════════════════════════════════════════════');
  console.log('策略'.padEnd(14) + ' | 2020-06(6年) | 2025-06 | 2024-06 | 2023-06 | 2022-06 | 2021-06 | 平均    ');
  console.log('─────────────────────────────────────────────────────────────────────────────────────────────');
  for (const s of STRATEGIES) {
    const r = results.filter(x => x.strategy === s.id);
    const cells = WINDOWS.map(w => {
      const rr = r.find(x => x.window === w.id);
      if (!rr) return '   N/A  ';
      return `${rr.maxDrawdown.toFixed(1).padStart(5)}%`;
    });
    const avg = r.reduce((a, b) => a + b.maxDrawdown, 0) / r.length;
    console.log(s.id.padEnd(14) + ' | ' + cells.join(' | ') + ' | ' + avg.toFixed(1).padStart(5) + '%');
  }
  console.log('─────────────────────────────────────────────────────────────────────────────────────────────');

  // 推荐
  console.log('\n');
  console.log('═══════════════════════════════════════════════════════════════════════════════════════════');
  console.log('🏆 综合排名（6 窗口平均收益 + 平均回撤，最稳健为最佳）');
  console.log('═══════════════════════════════════════════════════════════════════════════════════════════');
  const ranked = STRATEGIES.map(s => {
    const r = results.filter(x => x.strategy === s.id);
    const avgReturn = r.reduce((a, b) => a + b.totalReturnPct, 0) / r.length;
    const avgDD = r.reduce((a, b) => a + b.maxDrawdown, 0) / r.length;
    const worstReturn = Math.min(...r.map(x => x.totalReturnPct));
    return { id: s.id, label: s.label, avgReturn, avgDD, worstReturn };
  }).sort((a, b) => b.avgReturn - a.avgReturn);

  for (let i = 0; i < ranked.length; i++) {
    const r = ranked[i];
    const sign = r.avgReturn >= 0 ? '+' : '';
    console.log(`${i + 1}. ${r.id.padEnd(10)} | 平均收益 ${sign}${r.avgReturn.toFixed(1)}% | 平均回撤 ${r.avgDD.toFixed(1)}% | 最差窗口 ${r.worstReturn.toFixed(1)}%`);
  }

  console.log('\n✅ 结果已写入 validate-result.json');
}

main().catch(err => {
  console.error('❌ Validation failed:', err);
  process.exit(1);
});
