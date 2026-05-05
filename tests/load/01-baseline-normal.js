/**
 * Scenario: quiet-hours baseline traffic (ETH only) for stable latency reference.
 * Profile: 50 constant VUs, 5–10 bets/session, 2–4s think time, 0.005–0.05 ETH wagers.
 * SLO: P95 < 25ms, P99 < 50ms, non-balance error rate < 0.5%.
 * Usage: k6 run tests/load/01-baseline-normal.js
 */

import ws   from 'k6/ws';
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Counter, Rate } from 'k6/metrics';

const BASE_URL    = __ENV.BASE_URL    || 'http://localhost:3000';
const WS_URL      = __ENV.WS_URL      || 'ws://localhost:3000/ws';
const WALLET_COUNT = 20;

// ─── Metrics ──────────────────────────────────────────────────────────────────
const betDuration       = new Trend('baseline_bet_duration_ms', true);
const betsSucceeded     = new Counter('baseline_bets_succeeded');
const betsInsufficient  = new Counter('baseline_bets_insufficient_balance');
const betsError         = new Counter('baseline_bets_error');
const betErrorRate      = new Rate('baseline_bet_error_rate');
const wsConnects        = new Counter('baseline_ws_connects');
const wsConnectFail     = new Counter('baseline_ws_connect_fail');

// ─── k6 options ───────────────────────────────────────────────────────────────
export const options = {
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
  scenarios: {
    baseline: {
      executor: 'constant-vus',
      vus: 50,
      duration: '4m',
    },
  },
  thresholds: {
    // k6 end-to-end includes Docker Desktop / nginx overhead (~6–8 ms on Windows)
    // Internal gateway P95 (Prometheus) should be <20 ms.
    'baseline_bet_duration_ms': ['p(95)<25', 'p(99)<50'],
    'baseline_bet_error_rate':  ['rate<0.005'],   // <0.5% non-balance errors
  },
};

// ─── Setup: pre-fetch tokens once ─────────────────────────────────────────────
export function setup() {
  const tokens = [];
  for (let i = 0; i < WALLET_COUNT; i++) {
    const res = http.get(`${BASE_URL}/api/v1/dev/token?walletIndex=${i}`);
    if (res.status !== 200) {
      console.error(`[setup] Token fetch failed for walletIndex=${i}: ${res.status}`);
      tokens.push(null);
      continue;
    }
    tokens.push(JSON.parse(res.body).token);
  }
  const valid = tokens.filter(Boolean).length;
  console.log(`[setup] 01-baseline-normal — ${valid}/${WALLET_COUNT} tokens ready`);
  console.log(`[setup] Scenario: quiet hours (2–4 AM UTC), 50 VUs, 8 min, ~10–20 bets/sec`);
  return { tokens };
}

// ─── Default VU function ──────────────────────────────────────────────────────
export default function (data) {
  const token = data.tokens[(__VU - 1) % WALLET_COUNT];
  if (!token) { betErrorRate.add(1); betsError.add(1); return; }

  // Each iteration = one WS session: 5–10 bets then close
  const betsThisSession = 5 + Math.floor(Math.random() * 6);   // 5..10
  let betCount          = 0;
  let betSentAt         = 0;
  let pendingBet        = false;

  const res = ws.connect(WS_URL, {}, (socket) => {

    // Phase 8: auth via first WS frame
    socket.on('open', () => {
      socket.send(JSON.stringify({ type: 'AUTH', token }));
    });

    socket.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }

      if (msg.type === 'AUTH_OK') {
        wsConnects.add(1);
        // Stagger first bet by VU index to spread initial burst evenly (10–500 ms)
        socket.setTimeout(sendBet, ((__VU - 1) % 50) * 10 + 10);
        return;
      }

      if (msg.type === 'PONG') return;

      if (msg.type === 'BET_RESULT') {
        const elapsed = Date.now() - betSentAt;
        betDuration.add(elapsed);
        betsSucceeded.add(1);
        betErrorRate.add(0);
        pendingBet = false;
        betCount++;

        if (betCount >= betsThisSession) {
          socket.close(); // session complete — VU will reconnect on next iteration
          return;
        }
        // Think time: 2–4 s (casual pace)
        socket.setTimeout(sendBet, 2000 + Math.random() * 2000);
      }

      if (msg.type === 'ERROR') {
        pendingBet = false;
        if (msg.code === 'INSUFFICIENT_BALANCE') {
          betsInsufficient.add(1);
          // Balance exhausted — wait a bit, then try again (simulates user waiting for deposit)
          socket.setTimeout(sendBet, 3000 + Math.random() * 3000);
        } else {
          betsError.add(1);
          betErrorRate.add(1);
          betCount++; // count as attempt even on error
          if (betCount >= betsThisSession) {
            socket.close();
            return;
          }
          socket.setTimeout(sendBet, 2000 + Math.random() * 2000);
        }
      }
    });

    socket.on('error', () => {
      betErrorRate.add(1);
      wsConnectFail.add(1);
      socket.close();
    });

    // Safety close in case no bets are received
    socket.setTimeout(() => socket.close(), 60000);

    function sendBet() {
      if (pendingBet) return;
      pendingBet = true;
      betSentAt  = Date.now();
      const target = 20 + Math.floor(Math.random() * 61);  // 20..80
      const dir    = Math.random() < 0.5 ? 'over' : 'under';
      socket.send(JSON.stringify({
        type:        'BET_REQUEST',
        clientSeed:  `baseline-vu${__VU}-s${betCount}-${Date.now()}`,
        wagerAmount: parseFloat((0.005 + Math.random() * 0.045).toFixed(4)),  // 0.005–0.05 ETH
        chain:       'ethereum',
        currency:    'ETH',
        target,
        direction:   dir,
      }));
    }
  });

  if (!res || res.status !== 101) wsConnectFail.add(1);
  check(res, { '01 ws:101': (r) => r && r.status === 101 });

  // Brief pause between sessions (simulates app close + reopen)
  sleep(1 + Math.random() * 2);
}

// ─── Summary ──────────────────────────────────────────────────────────────────
export function handleSummary(data) {
  const m       = data.metrics;
  const p95     = m['baseline_bet_duration_ms']?.values?.['p(95)']  ?? 999;
  const p99     = m['baseline_bet_duration_ms']?.values?.['p(99)']  ?? 999;
  const errRate = m['baseline_bet_error_rate']?.values?.rate         ?? 1;
  const ok      = m['baseline_bets_succeeded']?.values?.count        ?? 0;
  const insuf   = m['baseline_bets_insufficient_balance']?.values?.count ?? 0;
  const errors  = m['baseline_bets_error']?.values?.count            ?? 0;
  const sloP95  = p95 < 25;
  const sloP99  = p99 < 50;
  const sloErr  = errRate < 0.005;
  const pass    = sloP95 && sloP99 && sloErr;

  console.log(`\n01-baseline: bets=${ok} insuf=${insuf} err=${errors} P95=${p95.toFixed(1)}ms P99=${p99.toFixed(1)}ms errRate=${(errRate*100).toFixed(2)}% ${pass ? 'PASS' : 'FAIL'}`);

  return {
    'results/01-baseline-normal-summary.json': JSON.stringify(data, null, 2),
    stdout: `\n01-baseline-normal: ${pass ? 'ALL PASS' : 'FAILURE'} | P95=${p95.toFixed(1)}ms P99=${p99.toFixed(1)}ms bets=${ok}\n`,
  };
}
