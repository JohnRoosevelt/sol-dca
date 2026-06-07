// SOL DCA Backtest V3 — 多时间窗口 + 长窗口
// 配置：每月 200 USDT × 10 期 = 2,000 USDT
// 输出：每个独立 10 个月窗口 + 1 个 6 年长窗口

const BASE_URL = 'https://www.okx.com/api/v5/market/history-candles';
const INST_ID = 'SOL-USDT';
const BAR = '1D';
const LIMIT = 100;

// === 配置 ===
const CONFIG = {
  perPeriodUSDT: 200,        // ← 每月 200 USDT
  totalInvestUSDT: 2000,     // ← 10 期 = 2,000 USDT
  totalMonths: 10,
  // 价格阈值
  pricePauseLine: 40,
  // 浮盈阶梯（按 2,000 USDT 总投入调整）
  profitStairs: [
    { trigger: 400, sell: 250 },
    { trigger: 800, sell: 300 },
    { trigger: 1200, sell: 400 },
    { trigger: 1800, sell: 500 },
    { trigger: 2500, sell: 550 },
  ],
  // 多窗口（独立 10 个月）
  windows: [
    { id: 'w2025', label: '2025-06 启动（牛尾入场）', start: '2025-06-20' },
    { id: 'w2024', label: '2024-06 启动（震荡市）',   start: '2024-06-20' },
    { id: 'w2023', label: '2023-06 启动（熊末反转）', start: '2023-06-20' },
    { id: 'w2022', label: '2022-06 启动（熊市深跌）', start: '2022-06-20' },
    { id: 'w2021', label: '2021-06 启动（牛市中部）', start: '2021-06-20' },
    { id: 'w2020', label: '2020-06 启动（早期）',     start: '2020-06-20' },
  ],
  // 长窗口：6 年连续 DCA
  longWindow: {
    label: '2020-06 → 2026-06 连续 DCA（6 年 72 期）',
    start: '2020-06-20',
    end: '2026-06-06',
  },
};

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
  // OKX 返回是倒序（最新在前），转成正序
  return all.map(k => ({
    ts: parseInt(k[0]),
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    vol: parseFloat(k[5]),
    date: new Date(parseInt(k[0])).toISOString().slice(0, 10),
  })).sort((a, b) => a.ts - b.ts);
}

// === 找日期的收盘价（找不到用前一个交易日）===
function getPriceOnDate(klines, dateStr) {
  const k = klines.find(k => k.date === dateStr);
  if (k) return k;
  const target = new Date(dateStr).getTime();
  const prev = klines.filter(k => k.ts <= target + 86400000).sort((a, b) => b.ts - a.ts)[0];
  if (!prev) throw new Error(`No price data on or before ${dateStr}`);
  return prev;
}

// === 每月定投日 ===
function getDcaDates(startDate, totalMonths) {
  const dates = [];
  const start = new Date(startDate);
  for (let i = 0; i < totalMonths; i++) {
    const d = new Date(start);
    d.setMonth(d.getMonth() + i);
    dates.push(d.toISOString().slice(0, 10));
  }
  return dates;
}

// === 单次回测（10 个月窗口）===
function runWindowBacktest(klines, startDate, totalMonths) {
  const events = [];
  let phase = 1;
  let cumulativeUSDT = 0;
  let cumulativeSOL = 0;
  let totalSOLBought = 0;
  let cumulativeSoldUSDT = 0;
  let paused = false;
  const stairTriggered = new Set();

  const dcaDates = getDcaDates(startDate, totalMonths);

  // 阶段 1: DCA
  for (let i = 0; i < dcaDates.length; i++) {
    const date = dcaDates[i];
    let k;
    try {
      k = getPriceOnDate(klines, date);
    } catch (e) {
      // 启动日早于 K 线起点，跳过
      events.push({ date, type: 'SKIP', note: e.message });
      continue;
    }
    const solBought = CONFIG.perPeriodUSDT / k.close;
    cumulativeUSDT += CONFIG.perPeriodUSDT;
    cumulativeSOL += solBought;
    totalSOLBought += solBought;
    const unrealizedPnL = cumulativeSOL * k.close - cumulativeUSDT;
    events.push({
      date,
      type: 'DCA_BUY',
      phase: 1,
      price: k.close,
      usdtSpent: CONFIG.perPeriodUSDT,
      solBought,
      cumulativeUSDT,
      cumulativeSOL,
      costAvgPrice: cumulativeUSDT / cumulativeSOL,
      marketValue: cumulativeSOL * k.close,
      unrealizedPnL,
      note: `第 ${i + 1}/${totalMonths} 期 DCA @ $${k.close.toFixed(2)}`,
    });
  }

  // 阶段 2: 监控（建仓完成后 60 天）
  const lastDcaDate = dcaDates[dcaDates.length - 1];
  const endTs = new Date(lastDcaDate).getTime() + 60 * 86400000;
  for (const k of klines) {
    if (k.date < lastDcaDate) continue;
    if (k.ts > endTs) break;
    if (phase === 1) phase = 2;

    if (!paused && k.low <= CONFIG.pricePauseLine) {
      paused = true;
      phase = 3;
      events.push({
        date: k.date,
        type: 'PAUSE_LINE_HIT',
        price: CONFIG.pricePauseLine,
        note: `跌穿 $${CONFIG.pricePauseLine} 暂停线`,
        cumulativeSOL, cumulativeUSDT,
      });
      continue;
    }

    if (!paused && phase === 2) {
      const unrealizedPnL = cumulativeSOL * k.close - cumulativeUSDT;
      for (let i = 0; i < CONFIG.profitStairs.length; i++) {
        if (stairTriggered.has(i)) continue;
        const stair = CONFIG.profitStairs[i];
        if (unrealizedPnL >= stair.trigger) {
          const sellUSDT = stair.sell;
          const sellSOL = sellUSDT / k.close;
          cumulativeSOL -= sellSOL;
          cumulativeUSDT -= sellUSDT;
          cumulativeSoldUSDT += sellUSDT;
          stairTriggered.add(i);
          events.push({
            date: k.date,
            type: 'PROFIT_STAIR_HIT',
            stair: i + 1,
            price: k.close,
            sellUSDT, sellSOL,
            cumulativeSOL, cumulativeUSDT, cumulativeSoldUSDT,
            unrealizedPnL,
            note: `浮盈 ≥ $${stair.trigger}，卖 $${sellUSDT}`,
          });
          if (i === CONFIG.profitStairs.length - 1) {
            phase = 3;
            events.push({
              date: k.date,
              type: 'PHASE_3_ENTRY',
              note: '🎉 本金全回笼，暂停 + 重新评估',
              remainingSOL: cumulativeSOL, cumulativeSoldUSDT,
            });
          }
        }
      }
    }
  }

  // 评估时点的最终价（建仓完成 + 60 天监控期）
  const evalDate = new Date(lastDcaDate).getTime() + 60 * 86400000;
  const evalK = klines.filter(k => k.ts <= evalTs()).sort((a, b) => b.ts - a.ts)[0]
    || klines[klines.length - 1];
  const evalPrice = evalK.close;
  const finalValue = cumulativeSOL * evalPrice;
  const finalProfit = finalValue + cumulativeSoldUSDT - CONFIG.totalInvestUSDT;
  const totalReturnPct = (finalProfit / CONFIG.totalInvestUSDT) * 100;
  const realCostAvg = CONFIG.totalInvestUSDT / totalSOLBought;

  return {
    startDate,
    evalDate: evalK.date,
    evalPrice,
    totalSOLBought,
    cumulativeSOL,
    cumulativeSoldUSDT,
    currentMarketValue: finalValue,
    realCostAvgPrice: realCostAvg,
    finalProfit,
    totalReturnPct,
    phase,
    paused,
    events,
  };
}

// 工具：建仓完成 + 60 天的 ms
function evalTs() {
  // 用 lastDcaDate + 60 天的逻辑由调用方传入
  return 0;
}

// === 长窗口（连续 6 年 DCA）===
function runLongWindowBacktest(klines, startDate, endDate) {
  const events = [];
  let cumulativeUSDT = 0;
  let cumulativeSOL = 0;
  let totalSOLBought = 0;
  let cumulativeSoldUSDT = 0;
  const monthlyProfits = [];  // 每月末的浮盈

  const start = new Date(startDate);
  const end = new Date(endDate);
  let current = new Date(start);
  let monthIdx = 0;

  while (current <= end) {
    const dateStr = current.toISOString().slice(0, 10);
    let k;
    try {
      k = getPriceOnDate(klines, dateStr);
    } catch (e) {
      current.setMonth(current.getMonth() + 1);
      continue;
    }
    const solBought = CONFIG.perPeriodUSDT / k.close;
    cumulativeUSDT += CONFIG.perPeriodUSDT;
    cumulativeSOL += solBought;
    totalSOLBought += solBought;
    const unrealizedPnL = cumulativeSOL * k.close - cumulativeUSDT;
    monthlyProfits.push({ date: dateStr, price: k.close, pnl: unrealizedPnL, solHeld: cumulativeSOL });
    events.push({
      date: dateStr,
      type: 'DCA_BUY',
      price: k.close,
      solBought,
      cumulativeUSDT, cumulativeSOL,
      costAvgPrice: cumulativeUSDT / cumulativeSOL,
      unrealizedPnL,
      note: `第 ${monthIdx + 1} 期 DCA @ $${k.close.toFixed(2)}`,
    });
    current.setMonth(current.getMonth() + 1);
    monthIdx++;
  }

  // 最终评估
  const lastK = klines[klines.length - 1];
  const finalValue = cumulativeSOL * lastK.close;
  const finalProfit = finalValue + cumulativeSoldUSDT - cumulativeUSDT;
  const totalReturnPct = (finalProfit / cumulativeUSDT) * 100;
  const realCostAvg = cumulativeUSDT / totalSOLBought;

  return {
    label: CONFIG.longWindow.label,
    startDate,
    endDate,
    totalPeriods: monthIdx,
    totalInvested: cumulativeUSDT,
    finalPrice: lastK.close,
    finalDate: lastK.date,
    totalSOLBought,
    cumulativeSOL,
    cumulativeSoldUSDT,
    currentMarketValue: finalValue,
    realCostAvgPrice: realCostAvg,
    finalProfit,
    totalReturnPct,
    monthlyProfits,
    events,
  };
}

// === 主程序 ===
async function main() {
  console.log('🚀 SOL DCA Backtest V3 — 多窗口 + 长窗口');
  console.log(`💰 每月 ${CONFIG.perPeriodUSDT} USDT × ${CONFIG.totalMonths} 期 = ${CONFIG.totalInvestUSDT} USDT`);
  console.log('');

  // 拉 6 年 K 线（2020-06 → 2026-06）
  const startTs = new Date('2020-06-01').getTime();
  console.log('📊 拉取 OKX SOL/USDT K 线（2018-2026）...');
  const klines = await fetchAllKLines(startTs);
  console.log(`   ✓ 拉到 ${klines.length} 天数据`);
  console.log(`   ✓ 时间范围: ${klines[0].date} → ${klines[klines.length - 1].date}`);
  console.log(`   ✓ SOL 期间价区间: $${Math.min(...klines.map(k => k.low)).toFixed(2)} - $${Math.max(...klines.map(k => k.high)).toFixed(2)}`);
  console.log('');

  // 跑多窗口
  console.log('🔄 跑多窗口回测...');
  const windows = [];
  for (const w of CONFIG.windows) {
    console.log(`   → ${w.label}`);
    const result = runWindowBacktest(klines, w.start, CONFIG.totalMonths);
    windows.push({ ...w, ...result });
    console.log(`     评估日 ${result.evalDate} @ $${result.evalPrice.toFixed(2)} | 收益 ${result.totalReturnPct.toFixed(2)}% ($${result.finalProfit.toFixed(2)}) | 阶段 ${result.phase}`);
  }

  // 跑长窗口
  console.log('');
  console.log('🔄 跑长窗口回测...');
  const longResult = runLongWindowBacktest(klines, CONFIG.longWindow.start, CONFIG.longWindow.end);
  console.log(`   ${longResult.label}`);
  console.log(`   总投入 $${longResult.totalInvested} | 最终价 $${longResult.finalPrice.toFixed(2)} | 收益 ${longResult.totalReturnPct.toFixed(2)}% ($${longResult.finalProfit.toFixed(2)})`);

  // 输出 JSON
  const fs = await import('fs');
  const output = {
    config: { perPeriodUSDT: CONFIG.perPeriodUSDT, totalInvestUSDT: CONFIG.totalInvestUSDT, totalMonths: CONFIG.totalMonths },
    priceRange: {
      allTimeLow: Math.min(...klines.map(k => k.low)),
      allTimeHigh: Math.max(...klines.map(k => k.high)),
      currentPrice: klines[klines.length - 1].close,
      currentDate: klines[klines.length - 1].date,
    },
    windows,
    longWindow: longResult,
    klinesCount: klines.length,
    klinesRange: { from: klines[0].date, to: klines[klines.length - 1].date },
  };
  fs.writeFileSync('./backtest-multi-result.json', JSON.stringify(output, null, 2));
  console.log('');
  console.log('✅ 结果已写入 backtest-multi-result.json');

  // 简洁对比表
  console.log('');
  console.log('═══════════════════════════════════════════════════');
  console.log('📊 多窗口对比（每月 200 USDT × 10 期 = 2,000 USDT）');
  console.log('═══════════════════════════════════════════════════');
  console.log('启动月份       评估日        评估价    收益 %     USDT');
  for (const w of windows) {
    const sign = w.finalProfit >= 0 ? '+' : '';
    console.log(`${w.start}  ${w.evalDate}  $${w.evalPrice.toFixed(2).padStart(7)}   ${sign}${w.totalReturnPct.toFixed(2)}%   ${sign}$${w.finalProfit.toFixed(2)}`);
  }
  console.log('─────────────────────────────────────────────────');
  console.log(`长窗口(6年连续)  ${longResult.finalDate}  $${longResult.finalPrice.toFixed(2).padStart(7)}   ${longResult.totalReturnPct >= 0 ? '+' : ''}${longResult.totalReturnPct.toFixed(2)}%   ${longResult.totalReturnPct >= 0 ? '+' : ''}$${longResult.finalProfit.toFixed(2)}`);
}

main().catch(err => {
  console.error('❌ Backtest failed:', err);
  process.exit(1);
});
