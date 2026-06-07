// SOL DCA 验证 V5 — V4 + 4 阶段分批回本
// 6 策略 × 2 模式（有/无分批回本）× 6 窗口 = 72 组合
// 关键：补全卖出侧 — 浮盈阶梯 + 价格阶梯

const BASE_URL = 'https://www.okx.com/api/v5/market/history-candles';
const INST_ID = 'SOL-USDT';
const BAR = '1D';
const LIMIT = 100;

// === 6 个策略（A-F） ===
// sellMode: 'none' | 'profit' | 'price'
// profit: 浮盈阶梯触发回本
// price:  价格阶梯触发止盈
const STRATEGIES = [
  { id: 'A_fix200', label: 'A. 固定 $200/月', type: 'fixed', perMonth: 200, initialUSDT: 7000, sellMode: 'none' },
  { id: 'A_fix200_sell', label: "A'. 固定 $200/月 + 分批回本", type: 'fixed', perMonth: 200, initialUSDT: 7000, sellMode: 'profit' },
  { id: 'B_fix300', label: 'B. 固定 $300/月', type: 'fixed', perMonth: 300, initialUSDT: 7000, sellMode: 'none' },
  { id: 'B_fix300_sell', label: "B'. 固定 $300/月 + 分批回本", type: 'fixed', perMonth: 300, initialUSDT: 7000, sellMode: 'profit' },
  { id: 'C_d5p_300', label: 'C. 5% 触发/$30U/次/月$300U', type: 'dynamic',
    baseAmount: 30, triggerPct: 5, monthLimit: 300, multiplierTiers: [], initialUSDT: 7000, sellMode: 'none' },
  { id: "C_d5p_300_sell", label: "C'. 5% 触发+分批回本", type: 'dynamic',
    baseAmount: 30, triggerPct: 5, monthLimit: 300, multiplierTiers: [], initialUSDT: 7000, sellMode: 'profit' },
  { id: 'D_d10p_300', label: 'D. 10% 触发/$30U/次/月$300U', type: 'dynamic',
    baseAmount: 30, triggerPct: 10, monthLimit: 300, multiplierTiers: [], initialUSDT: 7000, sellMode: 'none' },
  { id: "D_d10p_300_sell", label: "D'. 10% 触发+分批回本", type: 'dynamic',
    baseAmount: 30, triggerPct: 10, monthLimit: 300, multiplierTiers: [], initialUSDT: 7000, sellMode: 'profit' },
  { id: 'E_d5p_5x', label: 'E. 5% 触发+1-5x加码/月$500U（推荐）', type: 'dynamic',
    baseAmount: 30, triggerPct: 5, monthLimit: 500,
    multiplierTiers: [
      { minDrop: 5,  multiplier: 1 },
      { minDrop: 10, multiplier: 2 },
      { minDrop: 20, multiplier: 3 },
      { minDrop: 30, multiplier: 4 },
      { minDrop: 50, multiplier: 5 },
    ],
    initialUSDT: 7000, sellMode: 'none' },
  { id: "E_d5p_5x_sell", label: "E'. 5% 触发+加码+分批回本", type: 'dynamic',
    baseAmount: 30, triggerPct: 5, monthLimit: 500,
    multiplierTiers: [
      { minDrop: 5,  multiplier: 1 },
      { minDrop: 10, multiplier: 2 },
      { minDrop: 20, multiplier: 3 },
      { minDrop: 30, multiplier: 4 },
      { minDrop: 50, multiplier: 5 },
    ],
    initialUSDT: 7000, sellMode: 'profit' },
  { id: 'F_d10p_5x', label: 'F. 10% 触发+1-5x加码/月$1000U（激进）', type: 'dynamic',
    baseAmount: 30, triggerPct: 10, monthLimit: 1000,
    multiplierTiers: [
      { minDrop: 10, multiplier: 1 },
      { minDrop: 20, multiplier: 2 },
      { minDrop: 30, multiplier: 3 },
      { minDrop: 50, multiplier: 4 },
      { minDrop: 70, multiplier: 5 },
    ],
    initialUSDT: 7000, sellMode: 'none' },
  { id: "F_d10p_5x_sell", label: "F'. 10% 触发+加码+分批回本", type: 'dynamic',
    baseAmount: 30, triggerPct: 10, monthLimit: 1000,
    multiplierTiers: [
      { minDrop: 10, multiplier: 1 },
      { minDrop: 20, multiplier: 2 },
      { minDrop: 30, multiplier: 3 },
      { minDrop: 50, multiplier: 4 },
      { minDrop: 70, multiplier: 5 },
    ],
    initialUSDT: 7000, sellMode: 'profit' },
];

const WINDOWS = [
  { id: 'w2025', label: '2025-06 牛尾入场', start: '2025-06-20', evalDate: '2026-04-20' },
  { id: 'w2024', label: '2024-06 震荡市',   start: '2024-06-20', evalDate: '2025-04-20' },
  { id: 'w2023', label: '2023-06 熊末反转', start: '2023-06-20', evalDate: '2024-04-20' },
  { id: 'w2022', label: '2022-06 熊市深跌', start: '2022-06-20', evalDate: '2023-04-20' },
  { id: 'w2021', label: '2021-06 牛市中部', start: '2021-06-20', evalDate: '2022-04-20' },
  { id: 'w_long', label: '2020-06 6年长窗口', start: '2020-06-20', evalDate: '2026-06-06' },
];

// === 分批回本阶梯（按累计投入的比例触发） ===
// 触发：浮盈 ≥ 累计投入 × ratio → 卖 30% 持仓
// 5 个台阶 → 累计卖 90% → 留 10% 底仓
const SELL_STAIRS = [
  { ratio: 0.5, sellPct: 0.3 },   // 浮盈 +50% → 卖 30%
  { ratio: 1.0, sellPct: 0.3 },   // 浮盈 +100% → 卖 30%（累计 60%）
  { ratio: 2.0, sellPct: 0.3 },   // 浮盈 +200% → 卖 30%（累计 90%）
];
// 永远留 10% 跑彩票仓

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

// === 检查分批回本是否触发 ===
function checkSellStairs(sol, totalSpent, usdt, currentPrice, sellTriggered) {
  if (sol < 0.001) return null;
  const currentValue = usdt + sol * currentPrice;
  const profit = currentValue - totalSpent;
  // 浮盈 = 当前总资产 - 累计投入
  for (let i = 0; i < SELL_STAIRS.length; i++) {
    if (sellTriggered.has(i)) continue;
    const stair = SELL_STAIRS[i];
    const triggerProfit = totalSpent * stair.ratio;
    if (profit >= triggerProfit && totalSpent > 0) {
      return { stairIdx: i, profit, triggerProfit, sellPct: stair.sellPct };
    }
  }
  return null;
}

// === Fixed DCA 模式（带/不带分批回本） ===
function runFixedDCA(klines, strategy, start, evalDate) {
  const events = [];
  let usdt = strategy.initialUSDT;
  let sol = 0;
  let buyCount = 0;
  let totalSpent = 0;
  let sellCount = 0;
  let totalSoldUSDT = 0;
  const monthSpent = {};
  let maxDrawdown = 0;
  let peakValue = strategy.initialUSDT;
  let firstBuyDate = null;
  const sellTriggered = new Set();
  const enableSell = strategy.sellMode !== 'none';

  const startDt = new Date(start);
  const evalDt = new Date(evalDate);
  const cur = new Date(startDt);
  while (cur <= evalDt) {
    const dateStr = cur.toISOString().slice(0, 10);
    let k;
    try { k = getPriceOnDate(klines, dateStr); }
    catch { cur.setMonth(cur.getMonth() + 1); continue; }

    // 检查分批回本
    if (enableSell) {
      const sellInfo = checkSellStairs(sol, totalSpent, usdt, k.close, sellTriggered);
      if (sellInfo) {
        const sellSol = sol * sellInfo.sellPct;
        const sellUSDT = sellSol * k.close;
        sol -= sellSol;
        usdt += sellUSDT;
        totalSoldUSDT += sellUSDT;
        sellCount++;
        sellTriggered.add(sellInfo.stairIdx);
        events.push({
          date: dateStr, type: 'SELL_STAIR', stair: sellInfo.stairIdx + 1,
          price: k.close, sellUSDT, sellSol,
          solBalance: sol, usdtBalance: usdt,
          profit: sellInfo.profit, triggerProfit: sellInfo.triggerProfit,
          note: `浮盈 +${(sellInfo.profit / Math.max(totalSpent, 1) * 100).toFixed(0)}% ≥ +${(sellInfo.triggerProfit / Math.max(totalSpent, 1) * 100).toFixed(0)}%，卖 ${(sellInfo.sellPct * 100).toFixed(0)}%（${sellSol.toFixed(4)} SOL）`,
        });
      }
    }

    // DCA 买入
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
      note: enableSell ? `DCA $${buyAmount}` : `固定 DCA $${buyAmount}`,
    });

    if (usdt < 1) {
      events.push({ date: dateStr, type: 'EXHAUSTED', note: '账户耗尽' });
      break;
    }
    cur.setMonth(cur.getMonth() + 1);
  }
  return finalize(events, usdt, sol, totalSpent, buyCount, firstBuyDate, evalDate, maxDrawdown, klines, strategy, sellCount, totalSoldUSDT);
}

// === Dynamic DCA 模式（带/不带分批回本） ===
function runDynamicDCA(klines, strategy, start, evalDate) {
  const events = [];
  let usdt = strategy.initialUSDT;
  let sol = 0;
  let lastBuyPrice = null;
  let buyCount = 0;
  let totalSpent = 0;
  let sellCount = 0;
  let totalSoldUSDT = 0;
  const monthSpent = {};
  let maxDrawdown = 0;
  let peakValue = strategy.initialUSDT;
  let firstBuyDate = null;
  const sellTriggered = new Set();
  const enableSell = strategy.sellMode !== 'none';

  for (const k of klines) {
    if (k.date < start) continue;
    if (k.date > evalDate) break;

    // 检查分批回本（每次 tick 都检查）
    if (enableSell) {
      const sellInfo = checkSellStairs(sol, totalSpent, usdt, k.close, sellTriggered);
      if (sellInfo) {
        const sellSol = sol * sellInfo.sellPct;
        const sellUSDT = sellSol * k.close;
        sol -= sellSol;
        usdt += sellUSDT;
        totalSoldUSDT += sellUSDT;
        sellCount++;
        sellTriggered.add(sellInfo.stairIdx);
        events.push({
          date: k.date, type: 'SELL_STAIR', stair: sellInfo.stairIdx + 1,
          price: k.close, sellUSDT, sellSol,
          solBalance: sol, usdtBalance: usdt,
          profit: sellInfo.profit, triggerProfit: sellInfo.triggerProfit,
          note: `浮盈 +${(sellInfo.profit / Math.max(totalSpent, 1) * 100).toFixed(0)}% ≥ +${(sellInfo.triggerProfit / Math.max(totalSpent, 1) * 100).toFixed(0)}%，卖 ${(sellInfo.sellPct * 100).toFixed(0)}%`,
        });
      }
    }

    // 触发判断
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
  return finalize(events, usdt, sol, totalSpent, buyCount, firstBuyDate, evalDate, maxDrawdown, klines, strategy, sellCount, totalSoldUSDT);
}

function finalize(events, usdt, sol, totalSpent, buyCount, firstBuyDate, evalDate, maxDrawdown, klines, strategy, sellCount, totalSoldUSDT) {
  const evalK = klines.filter(k => k.date <= evalDate).sort((a, b) => b.ts - a.ts)[0] || klines[klines.length - 1];
  const finalPrice = evalK.close;
  const finalValue = sol * finalPrice + usdt;
  const finalProfit = finalValue - strategy.initialUSDT;
  const totalReturnPct = (finalProfit / strategy.initialUSDT) * 100;
  const avgCost = 0; // 简化版不计算，避免循环引用
  const monthsActive = firstBuyDate
    ? Math.max(1, Math.round((new Date(evalDate) - new Date(firstBuyDate)) / (30 * 86400000)))
    : 0;
  const avgPerMonth = monthsActive > 0 ? totalSpent / monthsActive : 0;
  return {
    finalPrice, buyCount, sellCount, totalSpent, totalSoldUSDT,
    usdtRemaining: usdt, solHolding: sol,
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
  console.log('🚀 SOL DCA 验证 V5 — 12 策略 × 6 窗口 = 72 组合（含分批回本）');
  console.log('');

  const startTs = new Date('2020-06-01').getTime();
  console.log('📊 拉取 OKX SOL/USDT 6 年 K 线...');
  const klines = await fetchAllKLines(startTs);
  console.log(`   ✓ ${klines.length} 天，${klines[0].date} → ${klines[klines.length - 1].date}`);
  console.log(`   ✓ 价区间: $${Math.min(...klines.map(k => k.low)).toFixed(2)} - $${Math.max(...klines.map(k => k.high)).toFixed(2)}`);
  console.log('');

  console.log('🔄 跑 72 组合回测...');
  const results = [];
  for (const s of STRATEGIES) {
    console.log(`\n📋 ${s.label} [sell=${s.sellMode}]`);
    for (const w of WINDOWS) {
      try {
        const r = runBacktest(klines, s, w.start, w.evalDate);
        r.strategy = s.id;
        r.strategyLabel = s.label;
        r.window = w.id;
        r.windowLabel = w.label;
        r.start = w.start;
        r.evalDate = w.evalDate;
        r.sellMode = s.sellMode;
        results.push(r);
        const sign = r.finalProfit >= 0 ? '+' : '';
        console.log(`   ${w.label.padEnd(25)} 期末 $${r.finalPrice.toFixed(2).padStart(7)} | 收益 ${sign}${r.totalReturnPct.toFixed(2).padStart(7)}% | 买 ${String(r.buyCount).padStart(3)} 卖 ${r.sellCount} | 回撤 ${r.maxDrawdown.toFixed(1)}%`);
      } catch (e) {
        console.log(`   ${w.label.padEnd(25)} ❌ ${e.message}`);
      }
    }
  }

  const fs = await import('fs');
  fs.writeFileSync('./validate-v5-result.json', JSON.stringify({
    generatedAt: new Date().toISOString(),
    priceRange: {
      allTimeLow: Math.min(...klines.map(k => k.low)),
      allTimeHigh: Math.max(...klines.map(k => k.high)),
      currentPrice: klines[klines.length - 1].close,
    },
    strategies: STRATEGIES,
    windows: WINDOWS,
    sellStairs: SELL_STAIRS,
    results,
  }, null, 2));

  // === 关键对比：分批回本 vs 无分批回本 ===
  console.log('\n');
  console.log('═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════');
  console.log('🔄 关键对比：有分批回本 vs 无分批回本（6 窗口平均）');
  console.log('═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════');
  console.log('策略'.padEnd(20) + ' | 无卖出平均收益 | 有卖出平均收益 | 提升幅度   | 无平均回撤   | 有平均回撤');
  console.log('─────────────────────────────────────────────────────────────────────────────────────────────────────');
  for (let i = 0; i < STRATEGIES.length; i += 2) {
    const sNo = STRATEGIES[i];
    const sYes = STRATEGIES[i + 1];
    if (!sYes) continue;
    const rNo = results.filter(x => x.strategy === sNo.id);
    const rYes = results.filter(x => x.strategy === sYes.id);
    const avgNo = rNo.reduce((a, b) => a + b.totalReturnPct, 0) / rNo.length;
    const avgYes = rYes.reduce((a, b) => a + b.totalReturnPct, 0) / rYes.length;
    const ddNo = rNo.reduce((a, b) => a + b.maxDrawdown, 0) / rNo.length;
    const ddYes = rYes.reduce((a, b) => a + b.maxDrawdown, 0) / rYes.length;
    const diff = avgYes - avgNo;
    const sign = avgNo >= 0 ? '+' : '';
    const sign2 = avgYes >= 0 ? '+' : '';
    const diffSign = diff >= 0 ? '+' : '';
    console.log(sNo.id.padEnd(20) + ' | ' + sign + avgNo.toFixed(1).padStart(5) + '%       | ' + sign2 + avgYes.toFixed(1).padStart(5) + '%       | ' + diffSign + diff.toFixed(1).padStart(5) + '%      | ' + ddNo.toFixed(1).padStart(5) + '%      | ' + ddYes.toFixed(1).padStart(5) + '%');
  }
  console.log('─────────────────────────────────────────────────────────────────────────────────────────────────────');

  // === 完整收益表 ===
  console.log('\n');
  console.log('═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════');
  console.log('📊 12 策略 × 6 窗口 — 期末总收益 %');
  console.log('═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════');
  console.log('策略/窗口      | 2020-06(6年) | 2025-06 | 2024-06 | 2023-06 | 2022-06 | 2021-06 | 平均    ');
  console.log('─────────────────────────────────────────────────────────────────────────────────────────────────────');
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
  console.log('─────────────────────────────────────────────────────────────────────────────────────────────────────');

  // 推荐
  console.log('\n');
  console.log('═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════');
  console.log('🏆 综合排名（6 窗口平均收益排序）');
  console.log('═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════');
  const ranked = STRATEGIES.map(s => {
    const r = results.filter(x => x.strategy === s.id);
    const avgReturn = r.reduce((a, b) => a + b.totalReturnPct, 0) / r.length;
    const avgDD = r.reduce((a, b) => a + b.maxDrawdown, 0) / r.length;
    const worstReturn = Math.min(...r.map(x => x.totalReturnPct));
    return { id: s.id, label: s.label, sellMode: s.sellMode, avgReturn, avgDD, worstReturn };
  }).sort((a, b) => b.avgReturn - a.avgReturn);

  for (let i = 0; i < ranked.length; i++) {
    const r = ranked[i];
    const sign = r.avgReturn >= 0 ? '+' : '';
    const sellTag = r.sellMode === 'profit' ? ' 💰分批回本' : '';
    console.log(`${i + 1}. ${r.id.padEnd(20)} | 平均收益 ${sign}${r.avgReturn.toFixed(1).padStart(6)}% | 平均回撤 ${r.avgDD.toFixed(1).padStart(5)}% | 最差 ${r.worstReturn.toFixed(1).padStart(5)}%${sellTag}`);
  }

  console.log('\n✅ 结果已写入 validate-v5-result.json');
}

main().catch(err => {
  console.error('❌ V5 Validation failed:', err);
  process.exit(1);
});
