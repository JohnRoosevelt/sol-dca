// SOL DCA 验证 V7+ — 当前价位入场测试
// user 反馈：V7 测的低位时点跟当前 $62 关系不大
// 跑 3 个"从 $150+ 高位跌到低位"的最接近当前场景
// 策略：E（启动即首买 + 2% 触发 + 1-5x 加码 + $500U 月限）

const BASE_URL = 'https://www.okx.com/api/v5/market/history-candles';
const INST_ID = 'SOL-USDT';
const BAR = '1D';
const LIMIT = 100;

// === 3 个"高位跌到底位"起点（最接近当前 $62 场景）===
const SCENARIOS = [
  {
    id: 's_2025_04',
    label: '2025-04-30 高位 $150 跌到当前 $62（最近 6 周暴跌 59%）',
    start: '2025-04-30',
    evalDate: '2026-04-30',
    note: '最接近当前场景，6 周内跌 59%',
  },
  {
    id: 's_2021_11',
    label: '2021-11-30 高位 $200 跌到熊底（2022 熊市持续 1 年）',
    start: '2021-11-30',
    evalDate: '2022-12-31',
    note: '2022 熊市 1 年，SOL 从 $200 跌到 $8 跌 95%',
  },
  {
    id: 's_2022_05',
    label: '2022-05-31 高位 $100 跌到 FTX 崩盘底 $8（跌 92%）',
    start: '2022-05-31',
    evalDate: '2023-05-31',
    note: 'FTX 崩盘前高位入场',
  },
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

function runScenarioBacktest(klines, start, evalDate) {
  const events = [];
  let usdt = 7000;
  let sol = 0;
  let lastBuyPrice = null;
  let buyCount = 0;
  let totalSpent = 0;
  const monthSpent = {};
  let maxDrawdown = 0;
  let peakValue = 7000;
  let entryPrice = null;

  const tiers = [
    { minDrop: 2, multiplier: 1 },
    { minDrop: 5, multiplier: 2 },
    { minDrop: 10, multiplier: 3 },
    { minDrop: 20, multiplier: 4 },
    { minDrop: 30, multiplier: 5 },
  ];

  for (const k of klines) {
    if (k.date < start) continue;
    if (k.date > evalDate) break;
    if (entryPrice === null) entryPrice = k.close;

    // 启动即首买
    if (lastBuyPrice === null) {
      const buyAmount = 30;
      const solBought = buyAmount / k.close;
      usdt -= buyAmount;
      sol += solBought;
      lastBuyPrice = k.close;
      buyCount++;
      totalSpent += buyAmount;
      events.push({ date: k.date, type: 'FIRST_BUY', price: k.close, usdtSpent: buyAmount, solBought, cumulativeSol: sol, note: '启动即首买' });
      continue;
    }

    const dropPct = (lastBuyPrice - k.close) / lastBuyPrice * 100;
    if (dropPct < 2) continue;

    const mult = getMultiplier(dropPct, tiers);
    let buyAmount = 30 * mult;
    const monthKey = k.date.slice(0, 7);
    const spent = monthSpent[monthKey] || 0;
    if (spent + buyAmount > 500) buyAmount = 500 - spent;
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

    events.push({ date: k.date, type: 'BUY', price: k.close, usdtSpent: buyAmount, solBought, dropPct, mult, note: `跌 ${dropPct.toFixed(1)}% ${mult}x 买 $${buyAmount}` });

    if (usdt < 1) {
      events.push({ date: k.date, type: 'EXHAUSTED' });
      break;
    }
  }

  const evalK = klines.filter(k => k.date <= evalDate).sort((a, b) => b.ts - a.ts)[0] || klines[klines.length - 1];
  const finalPrice = evalK.close;
  const finalValue = sol * finalPrice + usdt;
  const finalProfit = finalValue - 7000;
  const totalReturnPct = finalProfit / 7000 * 100;
  // 1 个月后快照
  const startTs = new Date(start).getTime();
  const s1mK = klines.find(k => Math.abs(k.ts - (startTs + 30 * 86400000)) < 5 * 86400000);
  const s1mValue = s1mK ? (s1mK.close * sol + (7000 - totalSpent)) : 0;
  const s1mPnl = s1mValue - 7000;

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
    s1mPnl,
    events: events.slice(0, 30),
  };
}

async function main() {
  console.log('🚀 SOL DCA 验证 V7+ — 当前价位入场测试');
  console.log('   3 个"从 $150+ 高位跌到低位"场景\n');

  const startTs = new Date('2021-11-01').getTime();
  console.log('📊 拉取 OKX SOL/USDT 5 年 K 线...');
  const klines = await fetchAllKLines(startTs);
  console.log(`   ✓ ${klines.length} 天 | 价区间 $${Math.min(...klines.map(k => k.low)).toFixed(2)} - $${Math.max(...klines.map(k => k.high)).toFixed(2)}\n`);

  const results = [];
  for (const s of SCENARIOS) {
    console.log(`\n📅 ${s.label}`);
    console.log(`   ${s.note}`);
    try {
      const r = runScenarioBacktest(klines, s.start, s.evalDate);
      r.scenario = s;
      r.id = s.id;
      results.push(r);
      const sign = r.finalProfit >= 0 ? '+' : '';
      const s1mSign = r.s1mPnl >= 0 ? '+' : '';
      console.log(`   启动 $${r.startPrice.toFixed(2).padStart(6)} 期末 $${r.finalPrice.toFixed(2).padStart(6)} | 1月后 ${s1mSign}$${r.s1mPnl.toFixed(0).padStart(5)} | 期末 ${sign}${r.totalReturnPct.toFixed(1).padStart(6)}% | 买 ${String(r.buyCount).padStart(2)} 次 | 回撤 ${r.maxDrawdown.toFixed(1).padStart(5)}%`);
    } catch (e) {
      console.log(`   ❌ ${e.message}`);
    }
  }

  const fs = await import('fs');
  fs.writeFileSync('./validate-v7plus-result.json', JSON.stringify({
    generatedAt: new Date().toISOString(),
    scenarios: SCENARIOS,
    results,
  }, null, 2));

  // === 汇总 ===
  console.log('\n\n══════════════════════════════════════════════════════════════════════════════════════════');
  console.log('📊 V7+ 汇总：高位跌到底位 3 场景 E 策略表现');
  console.log('══════════════════════════════════════════════════════════════════════════════════════════');
  console.log('场景                                          | 启动价  | 期末价 | 1月浮盈 | 期末收益 | 买入次 | 回撤');
  console.log('─────────────────────────────────────────────────────────────────────────────────────────────');
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const s = r.scenario;
    const sign = r.finalProfit >= 0 ? '+' : '';
    const s1mSign = r.s1mPnl >= 0 ? '+' : '';
    const labelShort = s.label.length > 45 ? s.label.slice(0, 43) + '..' : s.label;
    console.log(`${labelShort.padEnd(45)} | $${r.startPrice.toFixed(2).padStart(6)} | $${r.finalPrice.toFixed(2).padStart(6)} | ${s1mSign}$${r.s1mPnl.toFixed(0).padStart(5)} | ${sign}${r.totalReturnPct.toFixed(1).padStart(6)}% | ${String(r.buyCount).padStart(4)} | ${r.maxDrawdown.toFixed(1).padStart(5)}%`);
  }
  console.log('─────────────────────────────────────────────────────────────────────────────────────────────');

  console.log('\n✅ 结果已写入 validate-v7plus-result.json');
}

main().catch(err => {
  console.error('❌ V7+ failed:', err);
  process.exit(1);
});
