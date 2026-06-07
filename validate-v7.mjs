// SOL DCA 验证 V7 — 低位入场测试
// 5 个低位起点 × 4 个策略变体 = 20 组合
// 关键问题：E 策略 5% 触发在低位是否太慢？首次入场时机？

const BASE_URL = 'https://www.okx.com/api/v5/market/history-candles';
const INST_ID = 'SOL-USDT';
const BAR = '1D';
const LIMIT = 100;

// === 5 个低位起点 ===
const LOW_START_DATES = [
  { id: 'low_2020_09', label: '2020-09 SOL 跌到 $1.5（DeFi 热度退潮）', start: '2020-09-20', evalDate: '2021-12-20' },
  { id: 'low_2021_07', label: '2021-07 BTC 腰斩后（SOL ~$25）', start: '2021-07-20', evalDate: '2022-12-20' },
  { id: 'low_2022_11', label: '2022-11 FTX 崩盘（SOL ~$13）', start: '2022-11-20', evalDate: '2023-12-20' },
  { id: 'low_2023_10', label: '2023-10 熊末（SOL ~$20）', start: '2023-10-20', evalDate: '2024-12-20' },
  { id: 'low_2024_08', label: '2024-08 中段（SOL ~$140）', start: '2024-08-20', evalDate: '2025-08-20' },
];

// === 4 个策略变体 ===
// firstBuy: "immediate"=启动即首买 | "wait10"=等跌 10% 才首买
const VARIANTS = [
  { id: 'V1_e5', label: 'E 基线（启动即首买 + 5% 触发）', firstBuy: 'immediate', triggerPct: 5 },
  { id: 'V2_e2', label: '激进（启动即首买 + 2% 触发）', firstBuy: 'immediate', triggerPct: 2 },
  { id: 'V3_e3', label: '中等（启动即首买 + 3% 触发）', firstBuy: 'immediate', triggerPct: 3 },
  { id: 'V4_wait10', label: '保守（等跌 10% 首买 + 5% 触发）', firstBuy: 'wait10', triggerPct: 5 },
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

function getMultiplier(dropPct, tiers) {
  let m = 1;
  for (const t of tiers) {
    if (dropPct >= t.minDrop) m = t.multiplier;
  }
  return m;
}

// === 核心回测（参数化首买时机 + 触发幅度）===
function runLowEntryBacktest(klines, variant, start, evalDate) {
  const events = [];
  let usdt = 7000;
  let sol = 0;
  let lastBuyPrice = null;
  let buyCount = 0;
  let totalSpent = 0;
  let firstBuyDone = false;
  let waitingFor10PctDrop = false;
  let entryPrice = null;
  const monthSpent = {};
  let maxDrawdown = 0;
  let peakValue = 7000;

  const tiers = [
    { minDrop: 5, multiplier: 1 },
    { minDrop: 10, multiplier: 2 },
    { minDrop: 20, multiplier: 3 },
    { minDrop: 30, multiplier: 4 },
    { minDrop: 50, multiplier: 5 },
  ];

  for (const k of klines) {
    if (k.date < start) continue;
    if (k.date > evalDate) break;

    // 记录启动日的价
    if (entryPrice === null) entryPrice = k.close;

    // 首买逻辑
    if (!firstBuyDone) {
      if (variant.firstBuy === 'immediate') {
        // 启动即首买
        const buyAmount = 30;
        const solBought = buyAmount / k.close;
        usdt -= buyAmount;
        sol += solBought;
        lastBuyPrice = k.close;
        buyCount++;
        totalSpent += buyAmount;
        firstBuyDone = true;
        events.push({ date: k.date, type: 'FIRST_BUY', price: k.close, usdtSpent: buyAmount, solBought, cumulativeSol: sol, note: '启动即首买' });
      } else if (variant.firstBuy === 'wait10') {
        // 等跌 10% 才首买
        if (lastBuyPrice === null) {
          // 还没买过，先记一个"假买"用来算跌幅
          lastBuyPrice = k.close;
          waitingFor10PctDrop = true;
        } else if (waitingFor10PctDrop) {
          const dropPct = (lastBuyPrice - k.close) / lastBuyPrice * 100;
          if (dropPct >= 10) {
            const buyAmount = 30;
            const solBought = buyAmount / k.close;
            usdt -= buyAmount;
            sol += solBought;
            lastBuyPrice = k.close;
            buyCount++;
            totalSpent += buyAmount;
            firstBuyDone = true;
            waitingFor10PctDrop = false;
            events.push({ date: k.date, type: 'FIRST_BUY', price: k.close, usdtSpent: buyAmount, solBought, cumulativeSol: sol, note: `等跌 10% 首买 (从 $${entryPrice.toFixed(2)} 跌到 $${k.close.toFixed(2)})` });
          } else {
            // 还在等，更新 lastBuyPrice 跟踪
            lastBuyPrice = k.close;
          }
        }
      }
      // 跟踪 drawdown
      const currentValue = usdt + sol * k.close;
      if (currentValue > peakValue) peakValue = currentValue;
      const dd = (currentValue - peakValue) / peakValue;
      if (dd < maxDrawdown) maxDrawdown = dd;
      continue;
    }

    // 触发判断（首买后）
    const dropPct = (lastBuyPrice - k.close) / lastBuyPrice * 100;
    if (dropPct < variant.triggerPct) {
      // 跟踪 drawdown
      const currentValue = usdt + sol * k.close;
      if (currentValue > peakValue) peakValue = currentValue;
      const dd = (currentValue - peakValue) / peakValue;
      if (dd < maxDrawdown) maxDrawdown = dd;
      continue;  // hold
    }

    const mult = getMultiplier(dropPct, tiers);
    let buyAmount = 30 * mult;
    const monthKey = k.date.slice(0, 7);
    const spent = monthSpent[monthKey] || 0;
    if (spent + buyAmount > 500) {
      buyAmount = 500 - spent;
    }
    if (buyAmount <= 0) continue;
    if (buyAmount > usdt) buyAmount = usdt;
    if (buyAmount < 1) continue;

    const solBought = buyAmount / k.close;
    usdt -= buyAmount;
    sol += solBought;
    lastBuyPrice = k.close;
    buyCount++;
    totalSpent += buyAmount;
    monthSpent[monthKey] = (monthSpent[monthKey] || 0) + buyAmount;

    const currentValue = usdt + sol * k.close;
    if (currentValue > peakValue) peakValue = currentValue;
    const dd = (currentValue - peakValue) / peakValue;
    if (dd < maxDrawdown) maxDrawdown = dd;

    events.push({ date: k.date, type: 'BUY', price: k.close, usdtSpent: buyAmount, solBought, dropPct, mult, cumulativeSol: sol, note: `跌 ${dropPct.toFixed(1)}% 触发 ${mult}x, 买 $${buyAmount}` });

    if (usdt < 1) {
      events.push({ date: k.date, type: 'EXHAUSTED', note: '账户耗尽' });
      break;
    }
  }

  const evalK = klines.filter(k => k.date <= evalDate).sort((a, b) => b.ts - a.ts)[0] || klines[klines.length - 1];
  const finalPrice = evalK.close;
  const finalValue = sol * finalPrice + usdt;
  const finalProfit = finalValue - 7000;
  const totalReturnPct = finalProfit / 7000 * 100;

  // 找到 1 个月 / 3 个月 / 6 个月后的快照
  const startTs = new Date(start).getTime();
  const snapshots = {
    '1m': klines.find(k => Math.abs(k.ts - (startTs + 30 * 86400000)) < 3 * 86400000),
    '3m': klines.find(k => Math.abs(k.ts - (startTs + 90 * 86400000)) < 5 * 86400000),
    '6m': klines.find(k => Math.abs(k.ts - (startTs + 180 * 86400000)) < 7 * 86400000),
  };

  return {
    startPrice: entryPrice,
    finalPrice,
    buyCount,
    totalSpent,
    usdtRemaining: usdt,
    solHolding: sol,
    finalValue,
    finalProfit,
    totalReturnPct,
    maxDrawdown: maxDrawdown * 100,
    firstBuyDone,
    events: events.slice(0, 50),
    snapshots,
  };
}

// === 主程序 ===
async function main() {
  console.log('🚀 SOL DCA 验证 V7 — 低位入场测试');
  console.log(`   5 个低位起点 × 4 个策略变体 = 20 组合`);
  console.log(`   关键问题：E 策略 5% 触发在低位是否太慢？首次入场时机？\n`);

  const startTs = new Date('2020-08-01').getTime();
  console.log('📊 拉取 OKX SOL/USDT 6 年 K 线...');
  const klines = await fetchAllKLines(startTs);
  console.log(`   ✓ ${klines.length} 天\n`);

  const results = [];
  for (const w of LOW_START_DATES) {
    console.log(`\n📅 ${w.label}`);
    for (const v of VARIANTS) {
      try {
        const r = runLowEntryBacktest(klines, v, w.start, w.evalDate);
        r.id = `${w.id}_${v.id}`;
        r.window = w;
        r.variant = v;
        results.push(r);
        const sign = r.finalProfit >= 0 ? '+' : '';
        // 1 个月后的浮盈
        const s1m = r.snapshots['1m'];
        const s1mPnl = s1m ? ((s1m.close * r.solHolding + (7000 - r.totalSpent)) - 7000) : 0;
        const s1mSign = s1mPnl >= 0 ? '+' : '';
        console.log(`   ${v.label.padEnd(40)} 启动 $${r.startPrice.toFixed(2).padStart(6)} 期末 $${r.finalPrice.toFixed(2).padStart(6)} | 1月后 ${s1mSign}$${s1mPnl.toFixed(0).padStart(5)} | 1年 ${sign}${r.totalReturnPct.toFixed(1).padStart(6)}% | 买 ${String(r.buyCount).padStart(2)} 次`);
      } catch (e) {
        console.log(`   ${v.label.padEnd(40)} ❌ ${e.message}`);
      }
    }
  }

  const fs = await import('fs');
  fs.writeFileSync('./validate-v7-result.json', JSON.stringify({
    generatedAt: new Date().toISOString(),
    variants: VARIANTS,
    lowStartDates: LOW_START_DATES,
    results,
  }, null, 2));

  // === 汇总 ===
  console.log('\n\n══════════════════════════════════════════════════════════════════════════════════════════');
  console.log('📊 V7 汇总：低位入场下 4 策略对比（4 变体 × 5 起点）');
  console.log('══════════════════════════════════════════════════════════════════════════════════════════');
  console.log('策略/起点'.padEnd(40) + ' | 2020-09 | 2021-07 | 2022-11 | 2023-10 | 2024-08 | 平均');
  console.log('─────────────────────────────────────────────────────────────────────────────────────────────');
  for (const v of VARIANTS) {
    const cells = LOW_START_DATES.map(w => {
      const r = results.find(x => x.id === `${w.id}_${v.id}`);
      if (!r) return '   N/A  ';
      const sign = r.totalReturnPct >= 0 ? '+' : '';
      return `${sign}${r.totalReturnPct.toFixed(1).padStart(5)}%`;
    });
    const r5 = results.filter(x => x.variant.id === v.id);
    const avg = r5.reduce((a, b) => a + b.totalReturnPct, 0) / r5.length;
    const sign = avg >= 0 ? '+' : '';
    console.log(v.id.padEnd(40) + ' | ' + cells.join(' | ') + ' | ' + sign + avg.toFixed(1) + '%');
  }
  console.log('─────────────────────────────────────────────────────────────────────────────────────────────');

  // 推荐
  console.log('\n🏆 排名（5 起点平均收益）');
  const ranked = VARIANTS.map(v => {
    const rs = results.filter(x => x.variant.id === v.id);
    const avg = rs.reduce((a, b) => a + b.totalReturnPct, 0) / rs.length;
    const worst = Math.min(...rs.map(x => x.totalReturnPct));
    return { id: v.id, label: v.label, avg, worst };
  }).sort((a, b) => b.avg - a.avg);
  for (let i = 0; i < ranked.length; i++) {
    const r = ranked[i];
    const sign = r.avg >= 0 ? '+' : '';
    const wsign = r.worst >= 0 ? '+' : '';
    console.log(`${i + 1}. ${r.id.padEnd(12)} | 平均 ${sign}${r.avg.toFixed(1).padStart(5)}% | 最差 ${wsign}${r.worst.toFixed(1).padStart(5)}% | ${r.label}`);
  }

  console.log('\n✅ 结果已写入 validate-v7-result.json');
}

main().catch(err => {
  console.error('❌ V7 failed:', err);
  process.exit(1);
});
