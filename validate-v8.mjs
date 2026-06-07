// SOL DCA 验证 V8 — XRP vs SOL 长期定投对比
// 2 币种 × 6 起点 = 12 组合
// 关键问题：哪个更适合长期 DCA？

const BASE_URL = 'https://www.okx.com/api/v5/market/history-candles';
const BAR = '1D';
const LIMIT = 100;

// === 2 个币种 ===
const COINS = [
  { id: 'SOL', label: 'SOL (Solana)', instId: 'SOL-USDT' },
  { id: 'XRP', label: 'XRP (Ripple)', instId: 'XRP-USDT' },
];

// === 6 个起点（用 V7 的低位起点 + 2025-06）===
const START_DATES = [
  { id: 'low_2020_09', label: '2020-09 SOL $1.5 / XRP $0.24', start: '2020-09-20', evalDate: '2021-12-20' },
  { id: 'low_2021_07', label: '2021-07 SOL $25 / XRP $0.55', start: '2021-07-20', evalDate: '2022-12-20' },
  { id: 'low_2022_11', label: '2022-11 SOL $13 / XRP $0.36', start: '2022-11-20', evalDate: '2023-12-20' },
  { id: 'low_2023_10', label: '2023-10 SOL $20 / XRP $0.50', start: '2023-10-20', evalDate: '2024-12-20' },
  { id: 'low_2024_08', label: '2024-08 SOL $140 / XRP $0.57', start: '2024-08-20', evalDate: '2025-08-20' },
  { id: 'now_2025_06', label: '2025-06 SOL $62 / XRP $2.20', start: '2025-06-06', evalDate: '2026-06-06' },
];

// === 拉 K 线（参数化币种）===
async function fetchKLines(instId, after = null) {
  const url = after
    ? `${BASE_URL}?instId=${instId}&bar=${BAR}&after=${after}&limit=${LIMIT}`
    : `${BASE_URL}?instId=${instId}&bar=${BAR}&limit=${LIMIT}`;
  const res = await fetch(url);
  const json = await res.json();
  if (json.code !== '0') throw new Error(`OKX API error: ${json.msg}`);
  return json.data;
}

async function fetchAllKLines(instId, startTs) {
  const all = [];
  let after = null;
  let safety = 0;
  while (safety < 30) {
    const data = await fetchKLines(instId, after);
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

// === 核心回测（参数化币种 + 启动即首买 + 2% 触发）===
function runCoinBacktest(klines, start, evalDate) {
  const events = [];
  let usdt = 7000;
  let coins = 0;  // 用 coins 代替 sol（通用币种单位）
  let lastBuyPrice = null;
  let buyCount = 0;
  let totalSpent = 0;
  const monthSpent = {};
  let maxDrawdown = 0;
  let peakValue = 7000;
  const firstBuyPrice = klines.find(k => k.date >= start)?.close;
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
      const coinBought = buyAmount / k.close;
      usdt -= buyAmount;
      coins += coinBought;
      lastBuyPrice = k.close;
      buyCount++;
      totalSpent += buyAmount;
      events.push({ date: k.date, type: 'FIRST_BUY', price: k.close, usdtSpent: buyAmount, coinBought, cumulativeCoins: coins, note: '启动即首买' });
      const currentValue = usdt + coins * k.close;
      if (currentValue > peakValue) peakValue = currentValue;
      const dd = (currentValue - peakValue) / peakValue;
      if (dd < maxDrawdown) maxDrawdown = dd;
      continue;
    }

    // 触发判断
    const dropPct = (lastBuyPrice - k.close) / lastBuyPrice * 100;
    if (dropPct < 2) {
      const currentValue = usdt + coins * k.close;
      if (currentValue > peakValue) peakValue = currentValue;
      const dd = (currentValue - peakValue) / peakValue;
      if (dd < maxDrawdown) maxDrawdown = dd;
      continue;
    }

    const mult = getMultiplier(dropPct, tiers);
    let buyAmount = 30 * mult;
    const monthKey = k.date.slice(0, 7);
    const spent = monthSpent[monthKey] || 0;
    if (spent + buyAmount > 500) buyAmount = 500 - spent;
    if (buyAmount <= 0) continue;
    if (buyAmount > usdt) buyAmount = usdt;
    if (buyAmount < 1) continue;

    const coinBought = buyAmount / k.close;
    usdt -= buyAmount;
    coins += coinBought;
    lastBuyPrice = k.close;
    buyCount++;
    totalSpent += buyAmount;
    monthSpent[monthKey] = (monthSpent[monthKey] || 0) + buyAmount;

    const currentValue = usdt + coins * k.close;
    if (currentValue > peakValue) peakValue = currentValue;
    const dd = (currentValue - peakValue) / peakValue;
    if (dd < maxDrawdown) maxDrawdown = dd;

    events.push({ date: k.date, type: 'BUY', price: k.close, usdtSpent: buyAmount, coinBought, dropPct, mult, cumulativeCoins: coins, note: `跌 ${dropPct.toFixed(1)}% 触发 ${mult}x, 买 $${buyAmount}` });

    if (usdt < 1) {
      events.push({ date: k.date, type: 'EXHAUSTED', note: '账户耗尽' });
      break;
    }
  }

  const evalK = klines.filter(k => k.date <= evalDate).sort((a, b) => b.ts - a.ts)[0] || klines[klines.length - 1];
  const finalPrice = evalK.close;
  const finalValue = coins * finalPrice + usdt;
  const finalProfit = finalValue - 7000;
  const totalReturnPct = finalProfit / 7000 * 100;

  return {
    startPrice: entryPrice,
    finalPrice,
    buyCount,
    totalSpent,
    usdtRemaining: usdt,
    coinsHolding: coins,
    finalValue,
    finalProfit,
    totalReturnPct,
    maxDrawdown: maxDrawdown * 100,
    events: events.slice(0, 30),
  };
}

async function main() {
  console.log('🚀 SOL DCA 验证 V8 — XRP vs SOL 长期 DCA 对比');
  console.log(`   2 币种 × 6 起点 = 12 组合`);
  console.log(`   策略：E（启动即首买 + 2% 触发 + 1-5x 加码 + $500U 月限）`);
  console.log(`   关键问题：哪个更适合长期 DCA？\n`);

  // 拉两个币种的 K 线（缓存）
  const candles = {};
  for (const coin of COINS) {
    const startTs = new Date('2020-08-01').getTime();
    console.log(`📊 拉取 OKX ${coin.instId} 6 年 K 线...`);
    const data = await fetchAllKLines(coin.instId, startTs);
    candles[coin.id] = data;
    const max = Math.max(...data.map(k => k.high));
    const min = Math.min(...data.map(k => k.low));
    console.log(`   ✓ ${data.length} 天 | $${min.toFixed(4)} - $${max.toFixed(2)}\n`);
  }

  const results = [];
  for (const coin of COINS) {
    console.log(`\n📈 ${coin.label} 回测`);
    for (const w of START_DATES) {
      try {
        const r = runCoinBacktest(candles[coin.id], w.start, w.evalDate);
        r.coin = coin.id;
        r.coinLabel = coin.label;
        r.window = w;
        r.id = `${coin.id}_${w.id}`;
        results.push(r);
        const sign = r.finalProfit >= 0 ? '+' : '';
        console.log(`   ${w.label.padEnd(45)} 启动 $${r.startPrice.toFixed(4).padStart(8)} 期末 $${r.finalPrice.toFixed(4).padStart(8)} | 收益 ${sign}${r.totalReturnPct.toFixed(1).padStart(7)}% | 买 ${String(r.buyCount).padStart(2)} 次 | 回撤 ${r.maxDrawdown.toFixed(1).padStart(5)}%`);
      } catch (e) {
        console.log(`   ${w.label.padEnd(45)} ❌ ${e.message}`);
      }
    }
  }

  const fs = await import('fs');
  fs.writeFileSync('./validate-v8-result.json', JSON.stringify({
    generatedAt: new Date().toISOString(),
    coins: COINS,
    startDates: START_DATES,
    results,
  }, null, 2));

  // === 汇总 ===
  console.log('\n\n══════════════════════════════════════════════════════════════════════════════════════════');
  console.log('📊 V8 汇总：SOL vs XRP 6 起点对比');
  console.log('══════════════════════════════════════════════════════════════════════════════════════════');
  console.log('币种/起点  | 2020-09 | 2021-07 | 2022-11 | 2023-10 | 2024-08 | 2025-06 | 平均');
  console.log('─────────────────────────────────────────────────────────────────────────────────────────────');
  for (const coin of COINS) {
    const cells = START_DATES.map(w => {
      const r = results.find(x => x.coin === coin.id && x.window.id === w.id);
      if (!r) return '   N/A  ';
      const sign = r.totalReturnPct >= 0 ? '+' : '';
      return `${sign}${r.totalReturnPct.toFixed(1).padStart(5)}%`;
    });
    const rAll = results.filter(x => x.coin === coin.id);
    const avg = rAll.reduce((a, b) => a + b.totalReturnPct, 0) / rAll.length;
    const sign = avg >= 0 ? '+' : '';
    console.log(`${coin.id.padEnd(11)} | ${cells.join(' | ')} | ${sign}${avg.toFixed(1)}%`);
  }
  console.log('─────────────────────────────────────────────────────────────────────────────────────────────');

  // 排名
  console.log('\n🏆 排名');
  const ranked = COINS.map(c => {
    const rs = results.filter(x => x.coin === c.id);
    const avg = rs.reduce((a, b) => a + b.totalReturnPct, 0) / rs.length;
    const worst = Math.min(...rs.map(x => x.totalReturnPct));
    const best = Math.max(...rs.map(x => x.totalReturnPct));
    const avgDD = rs.reduce((a, b) => a + b.maxDrawdown, 0) / rs.length;
    return { id: c.id, label: c.label, avg, worst, best, avgDD };
  }).sort((a, b) => b.avg - a.avg);
  for (let i = 0; i < ranked.length; i++) {
    const r = ranked[i];
    const sign = r.avg >= 0 ? '+' : '';
    const wsign = r.worst >= 0 ? '+' : '';
    console.log(`${i + 1}. ${r.id.padEnd(4)} | 平均 ${sign}${r.avg.toFixed(1).padStart(5)}% | 最好 ${sign}${r.best.toFixed(1).padStart(5)}% | 最差 ${wsign}${r.worst.toFixed(1).padStart(5)}% | 平均回撤 ${r.avgDD.toFixed(1).padStart(5)}% | ${r.label}`);
  }

  console.log('\n✅ 结果已写入 validate-v8-result.json');
}

main().catch(err => {
  console.error('❌ V8 failed:', err);
  process.exit(1);
});
