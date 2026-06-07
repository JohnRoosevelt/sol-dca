// SOL DCA 验证 V6 — 参数化扫描分批回本参数
// 维度：触发基线 × 卖出比例 × 阶梯数
// 总组合：4 × 3 × 2 = 24 × 6 窗口 = 144 回测
// 策略基线：E_d5p_5x（V5 综合最优）

const BASE_URL = 'https://www.okx.com/api/v5/market/history-candles';
const INST_ID = 'SOL-USDT';
const BAR = '1D';
const LIMIT = 100;

// === E 策略基线（V5 推荐） ===
const BASE_STRATEGY = {
  id: 'E_d5p_5x',
  type: 'dynamic',
  baseAmount: 30,
  triggerPct: 5,
  monthLimit: 500,
  multiplierTiers: [
    { minDrop: 5,  multiplier: 1 },
    { minDrop: 10, multiplier: 2 },
    { minDrop: 20, multiplier: 3 },
    { minDrop: 30, multiplier: 4 },
    { minDrop: 50, multiplier: 5 },
  ],
  initialUSDT: 7000,
};

// === 参数空间 ===
const TRIGGER_BASES = [0.3, 0.5, 0.7, 1.0];   // 4 档
const SELL_PCTS = [0.2, 0.3, 0.4];            // 3 档
const STAIR_COUNTS = [3, 5];                  // 2 档
const BASE_LOT = 0.1;                         // 底仓 10%

// === 6 个窗口 ===
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

// === 生成阶梯比例数组 ===
function buildStairRatios(base, count) {
  if (count === 3) return [base, base * 2, base * 3];
  if (count === 5) return [base, base * 1.5, base * 2, base * 3, base * 5];
  return [base];
}

// === 检查分批回本触发（参数化）===
function checkSellStairsV6(sol, totalSpent, usdt, currentPrice, sellTriggered, stairRatios, sellPct) {
  if (sol < 0.001) return null;
  const currentValue = usdt + sol * currentPrice;
  const profit = currentValue - totalSpent;
  for (let i = 0; i < stairRatios.length; i++) {
    if (sellTriggered.has(i)) continue;
    const triggerProfit = totalSpent * stairRatios[i];
    if (profit >= triggerProfit && totalSpent > 0) {
      return { stairIdx: i, profit, triggerProfit, sellPct, ratio: stairRatios[i] };
    }
  }
  return null;
}

// === E 策略 + 参数化分批回本 ===
function runEWithSellParams(klines, baseStrategy, sellParams, start, evalDate) {
  const events = [];
  let usdt = baseStrategy.initialUSDT;
  let sol = 0;
  let lastBuyPrice = null;
  let buyCount = 0;
  let totalSpent = 0;
  let sellCount = 0;
  let totalSoldUSDT = 0;
  const monthSpent = {};
  let maxDrawdown = 0;
  let peakValue = baseStrategy.initialUSDT;
  let firstBuyDate = null;
  const sellTriggered = new Set();
  const stairRatios = buildStairRatios(sellParams.triggerBase, sellParams.stairCount);

  for (const k of klines) {
    if (k.date < start) continue;
    if (k.date > evalDate) break;

    // 分批回本检查
    if (sellParams.enabled) {
      const sellInfo = checkSellStairsV6(sol, totalSpent, usdt, k.close, sellTriggered, stairRatios, sellParams.sellPct);
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
          ratio: sellInfo.ratio,
          note: `浮盈 +${(sellInfo.profit / Math.max(totalSpent, 1) * 100).toFixed(0)}% ≥ +${(sellInfo.triggerProfit / Math.max(totalSpent, 1) * 100).toFixed(0)}%（r=${sellInfo.ratio.toFixed(1)}），卖 ${(sellInfo.sellPct * 100).toFixed(0)}%`,
        });
      }
    }

    // DCA 触发判断
    let buyAmount = 0;
    let triggerDropPct = null;
    if (lastBuyPrice === null) {
      buyAmount = baseStrategy.baseAmount;
    } else {
      const dropPct = (lastBuyPrice - k.close) / lastBuyPrice * 100;
      if (dropPct >= baseStrategy.triggerPct) {
        triggerDropPct = dropPct;
        const mult = getMultiplier(dropPct, baseStrategy.multiplierTiers);
        buyAmount = baseStrategy.baseAmount * mult;
        const monthKey = k.date.slice(0, 7);
        const spent = monthSpent[monthKey] || 0;
        if (spent + buyAmount > baseStrategy.monthLimit) {
          buyAmount = baseStrategy.monthLimit - spent;
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
      usdtBalance: usdt, solBalance: sol,
      triggerDropPct,
      note: triggerDropPct
        ? `跌 ${triggerDropPct.toFixed(1)}% 触发，买 $${buyAmount}`
        : `首买 $${buyAmount}`,
    });

    if (usdt < 1) {
      events.push({ date: k.date, type: 'EXHAUSTED', note: '账户耗尽' });
      break;
    }
  }

  const evalK = klines.filter(k => k.date <= evalDate).sort((a, b) => b.ts - a.ts)[0] || klines[klines.length - 1];
  const finalPrice = evalK.close;
  const finalValue = sol * finalPrice + usdt;
  const finalProfit = finalValue - baseStrategy.initialUSDT;
  const totalReturnPct = (finalProfit / baseStrategy.initialUSDT) * 100;
  return {
    finalPrice, buyCount, sellCount, totalSpent, totalSoldUSDT,
    usdtRemaining: usdt, solHolding: sol,
    currentSolValue: sol * finalPrice, finalValue, finalProfit, totalReturnPct,
    maxDrawdown: maxDrawdown * 100, sellParams, stairRatios,
    events: events.slice(0, 100),
  };
}

// === 主程序 ===
async function main() {
  console.log('🚀 SOL DCA 验证 V6 — 参数化扫描分批回本参数');
  console.log(`   基线策略: E_d5p_5x（5% 触发 + 1-5x 加码 + $500U 月限）`);
  console.log(`   维度: 触发基线 [${TRIGGER_BASES.join(', ')}] × 卖出比例 [${SELL_PCTS.join(', ')}] × 阶梯数 [${STAIR_COUNTS.join(', ')}]`);
  console.log(`   总组合: ${TRIGGER_BASES.length} × ${SELL_PCTS.length} × ${STAIR_COUNTS.length} = ${TRIGGER_BASES.length * SELL_PCTS.length * STAIR_COUNTS.length} × 6 窗口 = ${TRIGGER_BASES.length * SELL_PCTS.length * STAIR_COUNTS.length * 6} 回测`);
  console.log('');

  const startTs = new Date('2020-06-01').getTime();
  console.log('📊 拉取 OKX SOL/USDT 6 年 K 线...');
  const klines = await fetchAllKLines(startTs);
  console.log(`   ✓ ${klines.length} 天，${klines[0].date} → ${klines[klines.length - 1].date}`);
  console.log('');

  // 跑所有组合
  const results = [];
  for (const triggerBase of TRIGGER_BASES) {
    for (const sellPct of SELL_PCTS) {
      for (const stairCount of STAIR_COUNTS) {
        const sellParams = {
          enabled: true,
          triggerBase,
          sellPct,
          stairCount,
        };
        const id = `r${triggerBase}_s${sellPct}_n${stairCount}`;
        console.log(`\n📋 ${id} (触发基线 ${triggerBase*100}%, 卖 ${sellPct*100}%, ${stairCount} 阶)`);
        for (const w of WINDOWS) {
          try {
            const r = runEWithSellParams(klines, BASE_STRATEGY, sellParams, w.start, w.evalDate);
            r.id = id;
            r.window = w.id;
            r.windowLabel = w.label;
            r.start = w.start;
            r.evalDate = w.evalDate;
            results.push(r);
            const sign = r.finalProfit >= 0 ? '+' : '';
            console.log(`   ${w.label.padEnd(25)} 期末 $${r.finalPrice.toFixed(2).padStart(7)} | 收益 ${sign}${r.totalReturnPct.toFixed(2).padStart(7)}% | 买 ${String(r.buyCount).padStart(3)} 卖 ${r.sellCount} | 回撤 ${r.maxDrawdown.toFixed(1)}%`);
          } catch (e) {
            console.log(`   ${w.label.padEnd(25)} ❌ ${e.message}`);
          }
        }
      }
    }
  }

  const fs = await import('fs');
  fs.writeFileSync('./validate-v6-result.json', JSON.stringify({
    generatedAt: new Date().toISOString(),
    baseStrategy: BASE_STRATEGY,
    paramSpace: { triggerBases: TRIGGER_BASES, sellPcts: SELL_PCTS, stairCounts: STAIR_COUNTS, baseLot: BASE_LOT },
    windows: WINDOWS,
    results,
  }, null, 2));

  // === 汇总 ===
  console.log('\n');
  console.log('═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════');
  console.log('📊 24 组合 × 6 窗口 — 期末总收益 %');
  console.log('═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════');
  console.log('参数/窗口      | 2020-06(6年) | 2025-06 | 2024-06 | 2023-06 | 2022-06 | 2021-06 | 平均    | 最差    ');
  console.log('─────────────────────────────────────────────────────────────────────────────────────────────────────────────────');
  const ids = [];
  for (const triggerBase of TRIGGER_BASES) {
    for (const sellPct of SELL_PCTS) {
      for (const stairCount of STAIR_COUNTS) {
        const id = `r${triggerBase}_s${sellPct}_n${stairCount}`;
        ids.push(id);
      }
    }
  }
  for (const id of ids) {
    const r = results.filter(x => x.id === id);
    const cells = WINDOWS.map(w => {
      const rr = r.find(x => x.window === w.id);
      if (!rr) return '   N/A  ';
      const sign = rr.totalReturnPct >= 0 ? '+' : '';
      return `${sign}${rr.totalReturnPct.toFixed(1).padStart(5)}%`;
    });
    const avg = r.reduce((a, b) => a + b.totalReturnPct, 0) / r.length;
    const worst = Math.min(...r.map(x => x.totalReturnPct));
    const sign = avg >= 0 ? '+' : '';
    const signW = worst >= 0 ? '+' : '';
    console.log(id.padEnd(14) + ' | ' + cells.join(' | ') + ' | ' + sign + avg.toFixed(1).padStart(5) + '% | ' + signW + worst.toFixed(1).padStart(5) + '%');
  }
  console.log('─────────────────────────────────────────────────────────────────────────────────────────────────────────────────');

  // 排名
  console.log('\n');
  console.log('═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════');
  console.log('🏆 排名（按"风险调整后收益"：6 窗口平均收益 ÷ 平均最大回撤绝对值）');
  console.log('═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════');
  const ranked = ids.map(id => {
    const r = results.filter(x => x.id === id);
    const avgReturn = r.reduce((a, b) => a + b.totalReturnPct, 0) / r.length;
    const avgDD = r.reduce((a, b) => a + b.maxDrawdown, 0) / r.length;
    const worstReturn = Math.min(...r.map(x => x.totalReturnPct));
    // 风险调整后收益：年化收益 / 最大回撤
    const riskAdj = avgDD < 0 ? avgReturn / Math.abs(avgDD) : avgReturn;
    return { id, avgReturn, avgDD, worstReturn, riskAdj };
  }).sort((a, b) => b.riskAdj - a.riskAdj);

  for (let i = 0; i < ranked.length; i++) {
    const r = ranked[i];
    const sign = r.avgReturn >= 0 ? '+' : '';
    const signW = r.worstReturn >= 0 ? '+' : '';
    console.log(`${i + 1}. ${r.id.padEnd(18)} | 平均 ${sign}${r.avgReturn.toFixed(1).padStart(6)}% | 回撤 ${r.avgDD.toFixed(1).padStart(5)}% | 最差 ${signW}${r.worstReturn.toFixed(1).padStart(5)}% | 风险调整 ${r.riskAdj.toFixed(2)}`);
  }

  console.log('\n✅ 结果已写入 validate-v6-result.json');
}

main().catch(err => {
  console.error('❌ V6 Validation failed:', err);
  process.exit(1);
});
