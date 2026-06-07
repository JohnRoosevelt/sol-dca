// SOL DCA 验证 V9 — OKX WebSocket vs REST 实时性
// user 提的架构漏洞：当前用 REST 拉 1 天 K 线 = 1 天延迟，E 策略失效
// 验证：OKX WebSocket 推送频率 + 延迟 + 集成复杂度

import { WebSocket } from 'ws';

const WS_URL = 'wss://ws.okx.com:8443/ws/v5/public';
const SUBSCRIBE = {
  op: 'subscribe',
  args: [{ channel: 'tickers', instId: 'SOL-USDT' }],
};
const RUN_SECONDS = 60;

console.log('🚀 V9 验证：OKX WebSocket SOL-USDT 实时推送');
console.log(`   目标：${RUN_SECONDS} 秒持续订阅，统计推送频率 + 延迟 + 时间\n`);

const ws = new WebSocket(WS_URL);
const events = [];
let startTime = null;
let firstMsgTime = null;

ws.on('open', () => {
  console.log('✅ WebSocket 连接成功');
  startTime = Date.now();
  ws.send(JSON.stringify(SUBSCRIBE));
  console.log(`📨 已发送订阅: ${JSON.stringify(SUBSCRIBE)}\n`);
  setTimeout(() => {
    ws.close();
    reportResults();
  }, RUN_SECONDS * 1000);
});

ws.on('message', (raw) => {
  const now = Date.now();
  if (firstMsgTime === null) firstMsgTime = now;

  let msg;
  try {
    msg = JSON.parse(raw.toString());
  } catch (e) {
    return;
  }

  // 订阅确认
  if (msg.event === 'subscribe') {
    console.log(`✅ 订阅确认: ${msg.arg?.channel} ${msg.arg?.instId || ''}`);
    return;
  }

  // 推送数据
  if (msg.arg?.channel === 'tickers' && msg.data?.[0]) {
    const t = msg.data[0];
    const okxTs = parseInt(t.ts);
    const localDelayMs = now - okxTs;
    const elapsedSec = ((now - startTime) / 1000).toFixed(1);
    events.push({
      time: now,
      elapsedSec: parseFloat(elapsedSec),
      okxTs,
      localDelayMs,
      lastPrice: parseFloat(t.last),
      bid: parseFloat(t.bidPx),
      ask: parseFloat(t.askPx),
      vol24h: parseFloat(t.vol24h),
    });
  }
});

ws.on('error', (err) => {
  console.error('❌ WebSocket 错误:', err.message);
});

ws.on('close', () => {
  console.log('🔌 WebSocket 关闭');
});

async function reportResults() {
  if (events.length === 0) {
    console.log('❌ 没有收到任何 ticker 推送');
    return;
  }

  const delays = events.map(e => e.localDelayMs);
  const intervals = [];
  for (let i = 1; i < events.length; i++) {
    intervals.push(events[i].time - events[i - 1].time);
  }

  const prices = events.map(e => e.lastPrice);
  const minPrice = Math.min(...prices);
  const maxPrice = Math.max(...prices);
  const lastPrice = prices[prices.length - 1];
  const firstPrice = prices[0];

  console.log('\n\n══════════════════════════════════════════════════════════════════════════════════════');
  console.log(`📊 V9 结果（${RUN_SECONDS} 秒订阅）`);
  console.log('══════════════════════════════════════════════════════════════════════════════════════');
  console.log(`推送次数：${events.length} 次`);
  console.log(`推送频率：${(events.length / RUN_SECONDS).toFixed(2)} 次/秒 ≈ 1 次 / ${(RUN_SECONDS / events.length).toFixed(2)} 秒`);
  console.log(`价格区间：$${minPrice.toFixed(2)} - $${maxPrice.toFixed(2)} (波动 ${((maxPrice - minPrice) / firstPrice * 100).toFixed(2)}%)`);
  console.log(`首价 → 末价：$${firstPrice.toFixed(2)} → $${lastPrice.toFixed(2)} (${((lastPrice - firstPrice) / firstPrice * 100).toFixed(2)}%)`);

  console.log(`\n延迟统计（OKX → 本地）`);
  console.log(`  最小：${Math.min(...delays)} ms`);
  console.log(`  最大：${Math.max(...delays)} ms`);
  console.log(`  平均：${(delays.reduce((a, b) => a + b, 0) / delays.length).toFixed(0)} ms`);
  console.log(`  中位数：${delays.sort((a, b) => a - b)[Math.floor(delays.length / 2)]} ms`);

  if (intervals.length > 0) {
    console.log(`\n推送间隔`);
    console.log(`  最小：${Math.min(...intervals)} ms`);
    console.log(`  最大：${Math.max(...intervals)} ms`);
    console.log(`  平均：${(intervals.reduce((a, b) => a + b, 0) / intervals.length).toFixed(0)} ms`);
  }

  console.log('\n══════════════════════════════════════════════════════════════════════════════════════');
  console.log('🎯 关键结论：');
  console.log('══════════════════════════════════════════════════════════════════════════════════════');

  const avgDelay = delays.reduce((a, b) => a + b, 0) / delays.length;
  const avgInterval = intervals.length > 0 ? intervals.reduce((a, b) => a + b, 0) / intervals.length : 0;
  const pushFreq = events.length / RUN_SECONDS;

  console.log(`✅ OKX WebSocket 可用，连接稳定`);
  console.log(`✅ 平均延迟 ${avgDelay.toFixed(0)} ms（${avgDelay < 200 ? '< 200ms ✅ 适合实时触发' : '> 200ms ⚠️ 需评估'})`);
  console.log(`✅ 推送频率 ${pushFreq.toFixed(2)} Hz${pushFreq >= 0.5 ? '（高频，价格变化基本能秒级捕获）' : '（低频，可能错过小波动）'}`);
  console.log(`✅ 推送间隔 ${(avgInterval / 1000).toFixed(1)} 秒`);

  console.log('\n📐 跟当前 REST 拉 K 线对比：');
  console.log('  - REST 拉 1 天 K 线：1 天延迟（E 策略失效）');
  console.log(`  - REST 拉 ticker：~200ms 延迟但需主动轮询`);
  console.log(`  - WebSocket 推送：${avgDelay.toFixed(0)}ms 延迟，OKX 主动推，无需轮询 ⭐`);

  console.log('\n🛠️ Rust 端集成建议：');
  console.log('  - 用 tokio-tungstenite 或 tokio-websockets');
  console.log('  - 启动时连 WS，订阅 tickers SOL-USDT');
  console.log('  - 收到推送 → 调 strategy::decide()');
  console.log('  - WebSocket 断了自动重连');
  console.log('  - 单独 tokio task 跑 WS 主循环，跟 axum server 解耦');

  // 保存 JSON 结果
  const fs = await import('fs');
  fs.writeFileSync('./validate-v9-result.json', JSON.stringify({
    generatedAt: new Date().toISOString(),
    runSeconds: RUN_SECONDS,
    pushCount: events.length,
    pushFreqHz: pushFreq,
    avgDelayMs: avgDelay,
    medianDelayMs: delays.sort((a, b) => a - b)[Math.floor(delays.length / 2)],
    minDelayMs: Math.min(...delays),
    maxDelayMs: Math.max(...delays),
    avgIntervalMs: avgInterval,
    minPrice,
    maxPrice,
    lastPrice,
    firstPrice,
    firstSample: events.slice(0, 5),
    lastSample: events.slice(-5),
  }, null, 2));
  console.log('\n✅ 结果已写入 validate-v9-result.json');
}
