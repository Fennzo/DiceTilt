/**
 * 02-evening-peak.js — Prime-time evening traffic with gradual ramp
 *
 * SCENARIO CONTEXT:
 *   Models MonkeyTilt during the 6–11 PM US East / EU afternoon overlap — the
 *   busiest window for crypto casinos. Traffic arrives in a smooth wave: users
 *   finish work, open the app in the evening, and leave when they go to bed.
 *
 *   Target scale: ~7,000–10,000 DAU (at 0.10–0.15 DAU:concurrent ratio →
 *   700–1,500 concurrent users). This test represents the lower end of that
 *   window — the ramp-up to, and hold at, evening peak.
 *
 *   Key differences from baseline:
 *     - Gradual 5–10 VU/sec ramp (not a step function) — matches organic user
 *       arrival, not a DDoS. Based on load testing best-practice research.
 *     - Multi-chain: 70% ETH bets, 30% SOL bets (realistic chain split)
 *     - Higher wagers: 0.01–0.2 ETH/SOL (regular evening players, not 4 AM casuals)
 *     - 400-VU peak sustained for 3 min, then tapers off (users go to sleep)
 *
 * TRAFFIC STAGES:
 *   Stage 1 (60s):  0→100 VUs     — early evening warm-up (dinner crowd arrives)
 *   Stage 2 (90s):  hold 100 VUs  — observe stability at initial load
 *   Stage 3 (60s):  100→300 VUs   — prime time ramp (~5 VU/sec)
 *   Stage 4 (90s):  hold 300 VUs  — prime time sustained
 *   Stage 5 (45s):  300→400 VUs   — late-evening peak (~2 VU/sec)
 *   Stage 6 (180s): hold 400 VUs  — peak plateau (prove system holds)
 *   Stage 7 (60s):  400→150 VUs   — post-peak taper (users go to sleep)
 *   Stage 8 (30s):  150→0 VUs     — wind down
 *   Total: ~9.5 min
 *
 * PROFILE:
 *   - Session: 8–15 bets per WS session, 1–3 s think time
 *   - Wager: random 0.01–0.2 ETH or SOL
 *   - Chain: Math.random() < 0.7 → ETH, else SOL
 *   - Wallets: 20 shared across VUs (realistic: same user on multiple devices)
 *
 * USAGE:
 *   k6 run tests/load/02-evening-peak.js
 *   k6 run --env BASE_URL=http://localhost:3000 --env WS_URL=ws://localhost:3000/ws \
 *           tests/load/02-evening-peak.js
 */

import ws   from 'k6/ws';
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Counter, Rate } from 'k6/metrics';

const BASE_URL     = __ENV.BASE_URL     || 'http://localhost:3000';
const WS_URL       = __ENV.WS_URL       || 'ws://localhost:3000/ws';
const WALLET_COUNT = 100;   // 400 peak VUs / 100 = 4/wallet ≤ MAX_CONNECTIONS_PER_USER=5

// ─── Metrics ──────────────────────────────────────────────────────────────────
const betDuration      = new Trend('peak_bet_duration_ms', true);
const betsEth          = new Counter('peak_bets_eth');
const betsSol          = new Counter('peak_bets_sol');
const betsInsufficient = new Counter('peak_bets_insufficient_balance');
const betsError        = new Counter('peak_bets_error');
const betErrorRate     = new Rate('peak_bet_error_rate');
const wsConnectFail    = new Counter('peak_ws_connect_fail');

// ─── k6 options ───────────────────────────────────────────────────────────────
export const options = {
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
  scenarios: {
    evening_peak: {
      executor:    'ramping-vus',
      startVUs:    0,
      stages: [  // Total: 615s (~10.25 min)
        { duration: '60s',  target: 100 },   // Stage 1: early evening warm-up
        { duration: '90s',  target: 100 },   // Stage 2: stability check at 100 VUs
        { duration: '60s',  target: 300 },   // Stage 3: prime time ramp (~3.3 VU/sec)
        { duration: '90s',  target: 300 },   // Stage 4: prime time sustained
        { duration: '45s',  target: 400 },   // Stage 5: peak surge
        { duration: '180s', target: 400 },   // Stage 6: peak plateau (3 min hold)
        { duration: '60s',  target: 150 },   // Stage 7: post-peak taper
        { duration: '30s',  target: 0   },   // Stage 8: wind down
      ],
      gracefulRampDown: '30s',
    },
  },
  thresholds: {
    'peak_bet_duration_ms':  ['p(95)<35', 'p(99)<75'],   // slightly relaxed for 400 VUs
    'peak_bet_error_rate':   ['rate<0.01'],               // <1% non-balance errors
  },
};

// ─── Setup ────────────────────────────────────────────────────────────────────
export function setup() {
  const tokens = [];
  for (let i = 0; i < WALLET_COUNT; i++) {
    const res = http.get(`${BASE_URL}/api/v1/dev/token?walletIndex=${i}`);
    if (res.status !== 200) { tokens.push(null); continue; }
    tokens.push(JSON.parse(res.body).token);
  }
  const valid = tokens.filter(Boolean).length;
  console.log(`[setup] 02-evening-peak — ${valid}/${WALLET_COUNT} tokens ready`);
  console.log(`[setup] Scenario: 6–11 PM peak, 0→400 VUs ramp, 615s (~10.25 min), ETH+SOL multi-chain`);
  return { tokens };
}

// ─── VU function ──────────────────────────────────────────────────────────────
export default function (data) {
  const token = data.tokens[(__VU - 1) % WALLET_COUNT];
  if (!token) { betErrorRate.add(1); betsError.add(1); return; }

  const betsThisSession = 8 + Math.floor(Math.random() * 8);  // 8..15
  let betCount = 0;
  let betSentAt = 0;
  let pendingBet = false;

  // 70% ETH, 30% SOL — realistic multi-chain mix
  const chain    = Math.random() < 0.7 ? 'ethereum' : 'solana';
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
        // Stagger across a 500ms window to spread burst across the stage
        socket.setTimeout(sendBet, 1 + Math.random() * 499);
        return;
      }

      if (msg.type === 'PONG') return;

      if (msg.type === 'BET_RESULT') {
        const elapsed = Date.now() - betSentAt;
        betDuration.add(elapsed);
        if (chain === 'ethereum') betsEth.add(1); else betsSol.add(1);
        betErrorRate.add(0);
        pendingBet = false;
        betCount++;

        if (betCount >= betsThisSession) { socket.close(); return; }
        // Think time: 1–3 s (regular evening player)
        socket.setTimeout(sendBet, 1000 + Math.random() * 2000);
      }

      if (msg.type === 'ERROR') {
        pendingBet = false;
        if (msg.code === 'INSUFFICIENT_BALANCE') {
          betsInsufficient.add(1);
          socket.setTimeout(sendBet, 2000 + Math.random() * 2000);
        } else {
          betsError.add(1);
          betErrorRate.add(1);
          betCount++;
          if (betCount >= betsThisSession) { socket.close(); return; }
          socket.setTimeout(sendBet, 1500);
        }
      }
    });

    socket.on('error', () => { betErrorRate.add(1); wsConnectFail.add(1); socket.close(); });
    socket.setTimeout(() => socket.close(), 90000);   // safety close

    function sendBet() {
      if (pendingBet) return;
      pendingBet = true;
      betSentAt  = Date.now();
      const target = 25 + Math.floor(Math.random() * 51);  // 25..75
      const dir    = Math.random() < 0.5 ? 'over' : 'under';
      // Wager: 0.01–0.2 ETH/SOL (regular evening bet size)
      const wager  = parseFloat((0.01 + Math.random() * 0.19).toFixed(4));
      socket.send(JSON.stringify({
        type:        'BET_REQUEST',
        clientSeed:  `peak-vu${__VU}-${chain}-${betCount}-${Date.now()}`,
        wagerAmount: wager,
        chain,
        currency,
        target,
        direction: dir,
      }));
    }
  });

  if (!res || res.status !== 101) wsConnectFail.add(1);
  check(res, { '02 ws:101': (r) => r && r.status === 101 });
  sleep(1 + Math.random() * 1.5);
}

// ─── Summary ──────────────────────────────────────────────────────────────────
export function handleSummary(data) {
  const m      = data.metrics;
  const p95    = m['peak_bet_duration_ms']?.values?.['p(95)']     ?? 999;
  const p99    = m['peak_bet_duration_ms']?.values?.['p(99)']     ?? 999;
  const errR   = m['peak_bet_error_rate']?.values?.rate            ?? 1;
  const eth    = m['peak_bets_eth']?.values?.count                 ?? 0;
  const sol    = m['peak_bets_sol']?.values?.count                 ?? 0;
  const insuf  = m['peak_bets_insufficient_balance']?.values?.count ?? 0;
  const errors = m['peak_bets_error']?.values?.count               ?? 0;
  const ok     = eth + sol;
  const total  = ok + insuf + errors;
  const durSec = 615;  // Sum of all stage durations: 60+90+60+90+45+180+60+30

  const sloP95 = p95 < 35;
  const sloP99 = p99 < 75;
  const sloErr = errR < 0.01;
  const pass   = sloP95 && sloP99 && sloErr;

  const ethPct = total > 0 ? ((eth / (ok || 1)) * 100).toFixed(1) : '0';
  const solPct = total > 0 ? ((sol / (ok || 1)) * 100).toFixed(1) : '0';

  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║    02 — EVENING PEAK (Prime Time 6–11 PM, Multi-Chain)       ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log(`  ETH bets               : ${eth}  (${ethPct}%)`);
  console.log(`  SOL bets               : ${sol}  (${solPct}%)`);
  console.log(`  Total succeeded        : ${ok}`);
  console.log(`  Total attempted        : ${total}`);
  console.log(`  INSUFFICIENT_BALANCE   : ${insuf}`);
  console.log(`  Unexpected errors      : ${errors}`);
  console.log(`  Throughput (approx)    : ${(ok / durSec).toFixed(1)} bets/sec (avg over full ramp cycle)`);
  console.log('  ─────────────────────────────────────────────────────────────');
  console.log(`  P95 e2e latency        : ${p95.toFixed(2)} ms  (SLO <35 ms)  ${sloP95 ? '✓ PASS' : '✗ FAIL'}`);
  console.log(`  P99 e2e latency        : ${p99.toFixed(2)} ms  (SLO <75 ms)  ${sloP99 ? '✓ PASS' : '✗ FAIL'}`);
  console.log(`  Unexpected error rate  : ${(errR * 100).toFixed(3)}%       (SLO <1%)   ${sloErr ? '✓ PASS' : '✗ FAIL'}`);
  console.log('  ─────────────────────────────────────────────────────────────');
  console.log(`  Overall result         : ${pass ? '✓ ALL SLOs PASSED' : '✗ SLO FAILURE'}`);
  console.log('  Stage guide: peak plateau (Stage 6, ~7:15–10:15 mark) should show');
  console.log('  stable P95 with no upward drift — check Grafana timeseries.');
  console.log('══════════════════════════════════════════════════════════════════\n');

  return {
    'results/02-evening-peak-summary.json': JSON.stringify(data, null, 2),
    stdout: `\n02-evening-peak: ${pass ? 'ALL PASS' : 'FAILURE'} | P95=${p95.toFixed(1)}ms bets=${ok} (${ethPct}% ETH / ${solPct}% SOL)\n`,
  };
}
