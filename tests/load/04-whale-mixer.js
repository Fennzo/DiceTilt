/**
 * 04-whale-mixer.js — Realistic 3-tier user population mix
 *
 * SCENARIO CONTEXT:
 *   The most realistic single test in this suite. Uses k6 parallel scenarios
 *   to simultaneously simulate the three user archetypes that make up a real
 *   crypto casino user base, modelled on verified industry data:
 *
 *     ┌──────────────────┬──────────┬─────────────┬──────────────────────┐
 *     │ Tier             │ % Users  │ % Revenue   │ Behavior             │
 *     ├──────────────────┼──────────┼─────────────┼──────────────────────┤
 *     │ Casual           │ ~75%     │ ~10%        │ Small bets, slow pace│
 *     │ Regular          │ ~20%     │ ~20%        │ Medium bets, active  │
 *     │ High-roller      │ ~5%      │ ~70%        │ Large bets, fast     │
 *     └──────────────────┴──────────┴─────────────┴──────────────────────┘
 *   Source: verified whale % and revenue skew from mobile gaming studies
 *
 *   VU allocation (250 total):
 *     - casual_gamblers  : 150 VUs — 60% of connections
 *     - regular_players  :  80 VUs — 32% of connections
 *     - high_rollers     :  20 VUs —  8% of connections
 *
 *   Each tier runs its own exec function with different:
 *     - Think time (casual: 3–8s | regular: 0.8–2s | whale: 0.3–0.7s)
 *     - Wager size (casual: 0.001–0.02 | regular: 0.02–0.1 | whale: 0.1–0.3 ETH)
 *     - Bets per session (casual: 3–6 | regular: 8–15 | whale: 15–25)
 *     - Chain mix (casual: 100% ETH | regular: 80% ETH | whale: 60% ETH)
 *
 * METRICS:
 *   Per-tier latency trends so you can see if whale traffic crowds out casual
 *   user SLOs (the most realistic production concern).
 *
 * USAGE:
 *   k6 run tests/load/04-whale-mixer.js
 *   k6 run --env BASE_URL=http://localhost:3000 --env WS_URL=ws://localhost:3000/ws \
 *           tests/load/04-whale-mixer.js
 */

import ws   from 'k6/ws';
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Counter, Rate } from 'k6/metrics';

const BASE_URL     = __ENV.BASE_URL     || 'http://localhost:3000';
const WS_URL       = __ENV.WS_URL       || 'ws://localhost:3000/ws';
// Wallet pool layout (k6 __VU is per-scenario, 1-indexed):
//   Indices 0–74  — shared casual + regular pool (75 wallets)
//     150 casual VUs: ceil(150/75)=2 per wallet
//      80 regular VUs: ceil(80/75)=2 per wallet → worst case 4/wallet ≤ 5 ✓
//   Indices 75–79 — dedicated whale pool (5 wallets)
//      20 whale VUs: 20/5 = 4 per wallet ≤ 5 ✓  (no overlap with casual/regular)
const WALLET_COUNT        = 80;
const WHALE_WALLET_OFFSET = 75;

// ─── Per-tier metrics ──────────────────────────────────────────────────────────
// Separate Trend per tier so Grafana / handleSummary can compare latency across tiers
const durCasual  = new Trend('mixer_bet_duration_casual_ms',  true);
const durRegular = new Trend('mixer_bet_duration_regular_ms', true);
const durWhale   = new Trend('mixer_bet_duration_whale_ms',   true);

const betsCasual  = new Counter('mixer_bets_casual');
const betsRegular = new Counter('mixer_bets_regular');
const betsWhale   = new Counter('mixer_bets_whale');

const errCasual   = new Counter('mixer_errors_casual');
const errRegular  = new Counter('mixer_errors_regular');
const errWhale    = new Counter('mixer_errors_whale');

const insufCasual  = new Counter('mixer_insufficient_casual');
const insufRegular = new Counter('mixer_insufficient_regular');
const insufWhale   = new Counter('mixer_insufficient_whale');

const betErrorRate = new Rate('mixer_bet_error_rate_overall');
const wsConnFail   = new Counter('mixer_ws_connect_fail');

// ─── k6 options ───────────────────────────────────────────────────────────────
export const options = {
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
  scenarios: {
    // Tier 1: Casual gamblers — 75% of user base, relaxed pace
    casual_gamblers: {
      executor: 'constant-vus',
      vus:      150,
      duration: '5m',
      exec:     'casualScenario',
      gracefulStop: '30s',
    },
    // Tier 2: Regular players — 20% of user base, moderate pace
    regular_players: {
      executor: 'constant-vus',
      vus:      80,
      duration: '5m',
      exec:     'regularScenario',
      gracefulStop: '30s',
    },
    // Tier 3: High-rollers / whales — 5% of user base, aggressive pace
    high_rollers: {
      executor: 'constant-vus',
      vus:      20,
      duration: '5m',
      exec:     'whaleScenario',
      gracefulStop: '30s',
    },
  },
  thresholds: {
    // Whale tier has the strictest SLO — they generate 70% of revenue and feel any lag
    'mixer_bet_duration_whale_ms':   ['p(95)<25', 'p(99)<50'],
    // Regular players
    'mixer_bet_duration_regular_ms': ['p(95)<35', 'p(99)<75'],
    // Casual players — more tolerant, but P99 can't be terrible
    'mixer_bet_duration_casual_ms':  ['p(95)<50', 'p(99)<100'],
    // Overall error rate
    'mixer_bet_error_rate_overall':  ['rate<0.01'],
  },
};

// ─── Shared setup ─────────────────────────────────────────────────────────────
export function setup() {
  const tokens = [];
  for (let i = 0; i < WALLET_COUNT; i++) {
    const res = http.get(`${BASE_URL}/api/v1/dev/token?walletIndex=${i}`);
    if (res.status !== 200) { tokens.push(null); continue; }
    tokens.push(JSON.parse(res.body).token);
  }
  const valid = tokens.filter(Boolean).length;
  console.log(`[setup] 04-whale-mixer — ${valid}/${WALLET_COUNT} tokens ready`);
  console.log(`[setup] Running 3 tiers concurrently: 150 casual + 80 regular + 20 whale = 250 total VUs`);
  console.log(`[setup] Duration: 10 min. Key question: do whales crowd out casual SLOs?`);
  return { tokens };
}

// ─── Shared WS session runner ─────────────────────────────────────────────────
function runSession(token, cfg, durTrend, successCtr, errCtr, insufCtr) {
  let betCount  = 0;
  let betSentAt = 0;
  let pendingBet = false;
  const betsThisSession = cfg.minBets + Math.floor(Math.random() * (cfg.maxBets - cfg.minBets + 1));
  const chain    = Math.random() < cfg.ethPct ? 'ethereum' : 'solana';
  const currency = chain === 'ethereum' ? 'ETH' : 'SOL';

  const res = ws.connect(WS_URL, {}, (socket) => {

    // Phase 8: auth via first WS frame
    socket.on('open', () => {
      socket.send(JSON.stringify({ type: 'AUTH', token }));
    });

    socket.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }

      if (msg.type === 'AUTH_OK') {
        socket.setTimeout(sendBet, 1 + Math.random() * (cfg.staggerMs - 1));
        return;
      }

      if (msg.type === 'PONG') return;

      if (msg.type === 'BET_RESULT') {
        durTrend.add(Date.now() - betSentAt);
        successCtr.add(1);
        betErrorRate.add(0);
        pendingBet = false;
        betCount++;
        if (betCount >= betsThisSession) { socket.close(); return; }
        // Think time varies per tier (passed in cfg)
        const think = cfg.minThinkMs + Math.random() * (cfg.maxThinkMs - cfg.minThinkMs);
        socket.setTimeout(sendBet, think);
      }

      if (msg.type === 'ERROR') {
        pendingBet = false;
        if (msg.code === 'INSUFFICIENT_BALANCE') {
          insufCtr.add(1);
          // After balance exhaustion: casual waits longer; whale reconnects instantly
          socket.setTimeout(sendBet, cfg.minThinkMs * 2);
        } else {
          errCtr.add(1);
          betErrorRate.add(1);
          betCount++;
          if (betCount >= betsThisSession) { socket.close(); return; }
          socket.setTimeout(sendBet, cfg.minThinkMs);
        }
      }
    });

    socket.on('error', () => { betErrorRate.add(1); wsConnFail.add(1); socket.close(); });
    socket.setTimeout(() => socket.close(), cfg.sessionTimeoutMs);

    function sendBet() {
      if (pendingBet) return;
      pendingBet = true;
      betSentAt  = Date.now();
      // Wager: tier-specific range
      const wager  = parseFloat((cfg.minWager + Math.random() * (cfg.maxWager - cfg.minWager)).toFixed(4));
      const target = cfg.minTarget + Math.floor(Math.random() * (cfg.maxTarget - cfg.minTarget + 1));
      socket.send(JSON.stringify({
        type:        'BET_REQUEST',
        clientSeed:  `${cfg.tier}-vu${__VU}-${betCount}-${Date.now()}`,
        wagerAmount: wager,
        chain,
        currency,
        target,
        direction: Math.random() < 0.5 ? 'over' : 'under',
      }));
    }
  });

  if (!res || res.status !== 101) wsConnFail.add(1);
  check(res, { '04 ws:101': (r) => r && r.status === 101 });
}

// ─── Tier-specific exec functions ─────────────────────────────────────────────

// Casual: slow, small bets, ETH only, long think time
export function casualScenario(data) {
  const token = data.tokens[(__VU - 1) % WHALE_WALLET_OFFSET];
  if (!token) { betErrorRate.add(1); errCasual.add(1); return; }
  runSession(token, {
    tier:           'casual',
    minBets:        3,   maxBets:    6,
    minThinkMs:     3000, maxThinkMs: 8000,
    minWager:       0.001, maxWager: 0.02,
    ethPct:         1.0,             // casual = 100% ETH (simpler users)
    minTarget:      20,  maxTarget:  80,
    staggerMs:      1000,
    sessionTimeoutMs: 90000,
  }, durCasual, betsCasual, errCasual, insufCasual);
  sleep(2 + Math.random() * 3);    // long pause between sessions (casual users drift)
}

// Regular: medium bets, mixed ETH/SOL, moderate think time
export function regularScenario(data) {
  const token = data.tokens[(__VU - 1) % WHALE_WALLET_OFFSET];
  if (!token) { betErrorRate.add(1); errRegular.add(1); return; }
  runSession(token, {
    tier:           'regular',
    minBets:        8,   maxBets:    15,
    minThinkMs:     800, maxThinkMs: 2000,
    minWager:       0.02, maxWager:  0.1,
    ethPct:         0.8,             // 80% ETH, 20% SOL
    minTarget:      25,  maxTarget:  75,
    staggerMs:      400,
    sessionTimeoutMs: 60000,
  }, durRegular, betsRegular, errRegular, insufRegular);
  sleep(1 + Math.random() * 1.5);
}

// Whale: larger bets, faster pace, mixed chains, many bets per session
export function whaleScenario(data) {
  // Whales use dedicated pool indices WHALE_WALLET_OFFSET..WALLET_COUNT-1
  // (no overlap with casual/regular which use 0..WHALE_WALLET_OFFSET-1)
  const token = data.tokens[WHALE_WALLET_OFFSET + ((__VU - 1) % 5)];
  if (!token) { betErrorRate.add(1); errWhale.add(1); return; }
  runSession(token, {
    tier:           'whale',
    minBets:        15,  maxBets:    25,
    minThinkMs:     300, maxThinkMs: 700,
    minWager:       0.1,  maxWager:  0.3,    // capped to survive 10 ETH starting balance
    ethPct:         0.6,             // 60% ETH, 40% SOL (more sophisticated chain usage)
    minTarget:      30,  maxTarget:  70,
    staggerMs:      100,
    sessionTimeoutMs: 40000,
  }, durWhale, betsWhale, errWhale, insufWhale);
  sleep(0.5 + Math.random() * 0.5);  // whales reconnect quickly
}

// ─── Summary ──────────────────────────────────────────────────────────────────
export function handleSummary(data) {
  const m = data.metrics;

  function pct(metric, p) { return m[metric]?.values?.[`p(${p})`] ?? 999; }
  function cnt(metric)     { return m[metric]?.values?.count        ?? 0;  }
  function rt(metric)      { return m[metric]?.values?.rate          ?? 1;  }

  const tiers = [
    { name: 'Casual',  durKey: 'mixer_bet_duration_casual_ms',  okKey: 'mixer_bets_casual',  errKey: 'mixer_errors_casual',  insufKey: 'mixer_insufficient_casual',  sloP95: 50,  sloP99: 100 },
    { name: 'Regular', durKey: 'mixer_bet_duration_regular_ms', okKey: 'mixer_bets_regular', errKey: 'mixer_errors_regular', insufKey: 'mixer_insufficient_regular', sloP95: 35,  sloP99: 75  },
    { name: 'Whale',   durKey: 'mixer_bet_duration_whale_ms',   okKey: 'mixer_bets_whale',   errKey: 'mixer_errors_whale',   insufKey: 'mixer_insufficient_whale',   sloP95: 25,  sloP99: 50  },
  ];

  const errR  = rt('mixer_bet_error_rate_overall');
  const connF = cnt('mixer_ws_connect_fail');

  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║         04 — WHALE MIXER (3-Tier Population, 250 VUs)        ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');

  let allPass = true;
  for (const t of tiers) {
    const p95   = pct(t.durKey, 95);
    const p99   = pct(t.durKey, 99);
    const ok    = cnt(t.okKey);
    const err   = cnt(t.errKey);
    const insuf = cnt(t.insufKey);
    const pass95 = p95 < t.sloP95;
    const pass99 = p99 < t.sloP99;
    if (!pass95 || !pass99) allPass = false;

    console.log(`\n  ┌─ ${t.name.toUpperCase().padEnd(8)} tier ───────────────────────────────────────────┐`);
    console.log(`  │  Bets succeeded  : ${ok}`);
    console.log(`  │  Errors          : ${err}  |  INSUFFICIENT_BALANCE: ${insuf}`);
    console.log(`  │  P95 latency     : ${p95.toFixed(2)} ms  (SLO <${t.sloP95} ms)  ${pass95 ? '✓' : '✗'}`);
    console.log(`  │  P99 latency     : ${p99.toFixed(2)} ms  (SLO <${t.sloP99} ms)  ${pass99 ? '✓' : '✗'}`);
    console.log(`  └${'─'.repeat(58)}┘`);
  }

  if (errR >= 0.01) allPass = false;

  console.log(`\n  Overall error rate   : ${(errR * 100).toFixed(3)}%  (SLO <1%)  ${errR < 0.01 ? '✓ PASS' : '✗ FAIL'}`);
  console.log(`  WS connect fails     : ${connF}`);
  console.log('  ─────────────────────────────────────────────────────────────');
  console.log(`  Overall result       : ${allPass ? '✓ ALL SLOs PASSED' : '✗ SLO FAILURE'}`);
  console.log('  Key insight: if whale P95 is much lower than casual P95,');
  console.log('  the system is fair across user tiers. A gap >2× suggests');
  console.log('  casual users are being deprioritized under concurrent whale load.');
  console.log('══════════════════════════════════════════════════════════════════\n');

  return {
    'results/04-whale-mixer-summary.json': JSON.stringify(data, null, 2),
    stdout: `\n04-whale-mixer: ${allPass ? 'ALL PASS' : 'FAILURE'} | casual-P95=${pct('mixer_bet_duration_casual_ms',95).toFixed(1)}ms regular-P95=${pct('mixer_bet_duration_regular_ms',95).toFixed(1)}ms whale-P95=${pct('mixer_bet_duration_whale_ms',95).toFixed(1)}ms\n`,
  };
}
