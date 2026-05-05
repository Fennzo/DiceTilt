/**
 * Scenario: evening prime-time ramp/plateau load with organic traffic wave.
 * Profile: 0->400 ramping VUs, 8–15 bets/session, 1–3s think time, 70% ETH / 30% SOL.
 * SLO: P95 < 35ms, P99 < 75ms, non-balance error rate < 1%.
 * Usage: k6 run tests/load/02-evening-peak.js
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
      stages: [  // Total: 305s (~5 min)
        { duration: '30s',  target: 100 },   // Stage 1: early evening warm-up
        { duration: '45s',  target: 100 },   // Stage 2: stability check at 100 VUs
        { duration: '30s',  target: 300 },   // Stage 3: prime time ramp
        { duration: '45s',  target: 300 },   // Stage 4: prime time sustained
        { duration: '20s',  target: 400 },   // Stage 5: peak surge
        { duration: '90s',  target: 400 },   // Stage 6: peak plateau (90s hold)
        { duration: '30s',  target: 150 },   // Stage 7: post-peak taper
        { duration: '15s',  target: 0   },   // Stage 8: wind down
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

  const sloP95 = p95 < 35;
  const sloP99 = p99 < 75;
  const sloErr = errR < 0.01;
  const pass   = sloP95 && sloP99 && sloErr;

  const ethPct = total > 0 ? ((eth / (ok || 1)) * 100).toFixed(1) : '0';
  const solPct = total > 0 ? ((sol / (ok || 1)) * 100).toFixed(1) : '0';

  console.log(`02-evening-peak ${pass ? 'PASS' : 'FAIL'} | bets=${ok}/${total} ETH=${ethPct}% SOL=${solPct}% P95=${p95.toFixed(1)}ms P99=${p99.toFixed(1)}ms errRate=${(errR * 100).toFixed(2)}%`);

  return {
    'results/02-evening-peak-summary.json': JSON.stringify(data, null, 2),
    stdout: `\n02-evening-peak: ${pass ? 'ALL PASS' : 'FAILURE'} | P95=${p95.toFixed(1)}ms bets=${ok} (${ethPct}% ETH / ${solPct}% SOL)\n`,
  };
}
