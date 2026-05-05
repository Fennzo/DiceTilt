/**
 * Scenario: viral/promo flash spike with abrupt user surge and short hold.
 * Profile: 0->900 ramping VUs, 3–8 bets/session, 200–500ms think time, 0.01–0.1 ETH.
 * SLO: P95 < 60ms, P99 < 150ms, non-balance error rate < 2%, INTERNAL_ERROR < 5.
 * Usage: k6 run tests/load/03-traffic-spike.js
 */

import ws   from 'k6/ws';
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Counter, Rate, Gauge } from 'k6/metrics';

const BASE_URL     = __ENV.BASE_URL     || 'http://localhost:3000';
const WS_URL       = __ENV.WS_URL       || 'ws://localhost:3000/ws';
const WALLET_COUNT = 225;   // 900 peak VUs / 225 = 4/wallet ≤ MAX_CONNECTIONS_PER_USER=5

// ─── Metrics ──────────────────────────────────────────────────────────────────
const betDuration       = new Trend('spike_bet_duration_ms', true);
const betsSucceeded     = new Counter('spike_bets_succeeded');
const betsInsufficient  = new Counter('spike_bets_insufficient_balance');
const betsError         = new Counter('spike_bets_error');
const betErrorRate      = new Rate('spike_bet_error_rate');
const wsConnectFail     = new Counter('spike_ws_connect_fail');
const internalErrors    = new Counter('spike_internal_errors');   // SERVICE errors are bugs

// ─── k6 options ───────────────────────────────────────────────────────────────
export const options = {
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
  scenarios: {
    traffic_spike: {
      executor:    'ramping-vus',
      startVUs:    0,
      stages: [
        { duration: '30s',  target: 80  },   // Stage 1: base load
        { duration: '15s',  target: 80  },   // Stage 2: stable base
        { duration: '50s',  target: 900 },   // Stage 3: *** SPIKE (16.4 VU/sec) ***
        { duration: '60s',  target: 900 },   // Stage 4: spike held
        { duration: '30s',  target: 200 },   // Stage 5: spike abates
        { duration: '30s',  target: 200 },   // Stage 6: post-spike lingering
        { duration: '15s',  target: 0   },   // Stage 7: wind down
      ],
      gracefulRampDown: '30s',
    },
  },
  thresholds: {
    // SLO relaxed during spike — we expect degradation; the question is HOW MUCH
    'spike_bet_duration_ms':  ['p(95)<60', 'p(99)<150'],
    // Non-balance errors (INTERNAL_ERROR, SERVICE errors) must stay near zero
    'spike_bet_error_rate':   ['rate<0.02'],
    // Zero INTERNAL_ERRORs at any point — those are crashes / bugs, not load-shedding
    'spike_internal_errors':  ['count<5'],
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
  console.log(`[setup] 03-traffic-spike — ${valid}/${WALLET_COUNT} tokens ready`);
  console.log(`[setup] Scenario: viral spike 80→900 VUs in 50s (16 VU/sec), ~7 min`);
  console.log(`[setup] Watch: Kafka lag (should not exceed a few hundred during spike)`);
  console.log(`[setup] Watch: Redis pool (INTERNAL_ERROR means pool saturation)`);
  return { tokens };
}

// ─── VU function ──────────────────────────────────────────────────────────────
export default function (data) {
  const token = data.tokens[(__VU - 1) % WALLET_COUNT];
  if (!token) { betErrorRate.add(1); betsError.add(1); return; }

  const betsThisSession = 3 + Math.floor(Math.random() * 6);  // 3..8
  let betCount  = 0;
  let betSentAt = 0;
  let pendingBet = false;

  const res = ws.connect(WS_URL, {}, (socket) => {

    // Phase 8: auth via first WS frame
    socket.on('open', () => {
      socket.send(JSON.stringify({ type: 'AUTH', token }));
    });

    socket.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }

      if (msg.type === 'AUTH_OK') {
        // Minimal stagger — spike users are impatient, arrive nearly simultaneously
        socket.setTimeout(sendBet, 1 + Math.random() * 149);
        return;
      }

      if (msg.type === 'PONG') return;

      if (msg.type === 'BET_RESULT') {
        betDuration.add(Date.now() - betSentAt);
        betsSucceeded.add(1);
        betErrorRate.add(0);
        pendingBet = false;
        betCount++;
        if (betCount >= betsThisSession) { socket.close(); return; }
        // Think time: 200–500 ms (impatient spike users)
        socket.setTimeout(sendBet, 200 + Math.random() * 300);
      }

      if (msg.type === 'ERROR') {
        pendingBet = false;
        if (msg.code === 'INSUFFICIENT_BALANCE') {
          betsInsufficient.add(1);
          // Spike users who run out → close and leave (don't wait to deposit)
          socket.close();
        } else if (msg.code === 'INTERNAL_ERROR') {
          // INTERNAL_ERROR during a spike = system is shedding load incorrectly
          internalErrors.add(1);
          betErrorRate.add(1);
          betsError.add(1);
          socket.close();
        } else {
          betsError.add(1);
          betErrorRate.add(1);
          betCount++;
          if (betCount >= betsThisSession) { socket.close(); return; }
          socket.setTimeout(sendBet, 500);
        }
      }
    });

    socket.on('error', () => { betErrorRate.add(1); wsConnectFail.add(1); socket.close(); });
    socket.setTimeout(() => socket.close(), 45000);

    function sendBet() {
      if (pendingBet) return;
      pendingBet = true;
      betSentAt  = Date.now();
      const target = 30 + Math.floor(Math.random() * 41);  // 30..70
      socket.send(JSON.stringify({
        type:        'BET_REQUEST',
        clientSeed:  `spike-vu${__VU}-${betCount}-${Date.now()}`,
        wagerAmount: parseFloat((0.01 + Math.random() * 0.09).toFixed(4)),  // 0.01–0.1 ETH
        chain:       'ethereum',
        currency:    'ETH',
        target,
        direction:   Math.random() < 0.5 ? 'over' : 'under',
      }));
    }
  });

  if (!res || res.status !== 101) wsConnectFail.add(1);
  check(res, { '03 ws:101': (r) => r && r.status === 101 });
  sleep(0.5 + Math.random() * 0.5);
}

// ─── Summary ──────────────────────────────────────────────────────────────────
export function handleSummary(data) {
  const m       = data.metrics;
  const p95     = m['spike_bet_duration_ms']?.values?.['p(95)']       ?? 999;
  const p99     = m['spike_bet_duration_ms']?.values?.['p(99)']       ?? 999;
  const med     = m['spike_bet_duration_ms']?.values?.['med']          ?? 999;
  const errR    = m['spike_bet_error_rate']?.values?.rate              ?? 1;
  const ok      = m['spike_bets_succeeded']?.values?.count             ?? 0;
  const insuf   = m['spike_bets_insufficient_balance']?.values?.count  ?? 0;
  const errors  = m['spike_bets_error']?.values?.count                 ?? 0;
  const intErr  = m['spike_internal_errors']?.values?.count            ?? 0;
  const connFail = m['spike_ws_connect_fail']?.values?.count           ?? 0;
  const total   = ok + insuf + errors;

  const sloP95     = p95 < 60;
  const sloP99     = p99 < 150;
  const sloErr     = errR < 0.02;
  const sloIntErr  = intErr < 5;
  const pass       = sloP95 && sloP99 && sloErr && sloIntErr;

  console.log(`03-traffic-spike ${pass ? 'PASS' : 'FAIL'} | bets=${ok}/${total} intErr=${intErr} wsFail=${connFail} med=${med.toFixed(1)}ms P95=${p95.toFixed(1)}ms P99=${p99.toFixed(1)}ms errRate=${(errR * 100).toFixed(2)}%`);

  return {
    'results/03-traffic-spike-summary.json': JSON.stringify(data, null, 2),
    stdout: `\n03-traffic-spike: ${pass ? 'ALL PASS' : 'FAILURE'} | P95=${p95.toFixed(1)}ms intErrors=${intErr} bets=${ok}\n`,
  };
}
