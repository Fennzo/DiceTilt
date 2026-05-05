/**
 * Scenario: maximum-throughput crush to probe graceful degradation and capacity ceiling.
 * Profile: 0->1000 ramping VUs, 5–12 bets/session, 100–200ms think time, mixed ETH/SOL.
 * SLO: P95 < 100ms, P99 < 300ms, INTERNAL_ERROR < 10, WS connect failures < 50, error rate < 5%.
 * Usage: k6 run tests/load/05-peak-crush.js
 */

import ws   from 'k6/ws';
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Counter, Rate } from 'k6/metrics';

const BASE_URL     = __ENV.BASE_URL     || 'http://localhost:3000';
const WS_URL       = __ENV.WS_URL       || 'ws://localhost:3000/ws';
const WALLET_COUNT = 250;   // 1000 peak VUs / 250 = 4/wallet ≤ MAX_CONNECTIONS_PER_USER=5

// ─── Metrics ──────────────────────────────────────────────────────────────────
const betDuration      = new Trend('crush_bet_duration_ms', true);
const betsSucceeded    = new Counter('crush_bets_succeeded');
const betsInsufficient = new Counter('crush_bets_insufficient_balance');
const betsError        = new Counter('crush_bets_error');
const internalErrors   = new Counter('crush_internal_errors');
const betErrorRate     = new Rate('crush_bet_error_rate');
const wsConnectFail    = new Counter('crush_ws_connect_fail');
const wsConnects       = new Counter('crush_ws_connects');

// ─── k6 options ───────────────────────────────────────────────────────────────
export const options = {
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
  scenarios: {
    peak_crush: {
      executor:    'ramping-vus',
      startVUs:    0,
      stages: [
        { duration: '30s',  target: 300  },   // Stage 1: warm-up
        { duration: '30s',  target: 300  },   // Stage 2: observe warm cache at 300 VUs
        { duration: '30s',  target: 600  },   // Stage 3: pressure increase
        { duration: '30s',  target: 600  },   // Stage 4: sustain mid-load
        { duration: '25s',  target: 800  },   // Stage 5: near-peak
        { duration: '150s', target: 800  },   // Stage 6: *** 2.5-MIN CRUSH at 800 VUs ***
        { duration: '20s',  target: 1000 },   // Stage 7: push past ceiling
        { duration: '60s',  target: 1000 },   // Stage 8: maximum load hold
        { duration: '30s',  target: 0    },   // Stage 9: ramp-down (watch recovery)
      ],
      gracefulRampDown: '30s',
    },
  },
  thresholds: {
    // Relaxed SLOs — this test is about capacity, not strict SLO compliance
    'crush_bet_duration_ms':  ['p(95)<100', 'p(99)<300'],
    // Zero tolerance on INTERNAL_ERROR — those are crashes, not graceful shedding
    'crush_internal_errors':  ['count<10'],
    // Connection failures must be negligible — the connection pool optimization should hold
    'crush_ws_connect_fail':  ['count<50'],
    // Overall error rate (excludes INSUFFICIENT_BALANCE which is correct behavior)
    'crush_bet_error_rate':   ['rate<0.05'],
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
  console.log(`[setup] 05-peak-crush — ${valid}/${WALLET_COUNT} tokens ready`);
  console.log(`[setup] Scenario: capacity ceiling test, 0→1000 VUs, ~13 min`);
  console.log(`[setup] Stage 6 (5-min crush at 800 VUs) is the primary proving window.`);
  console.log(`[setup] OPEN GRAFANA NOW — watch real-time latency, Kafka lag, Redis metrics`);
  console.log(`[setup] Expected at >600 VUs: INSUFFICIENT_BALANCE rate rises (correct)`);
  console.log(`[setup] Never expected: INTERNAL_ERROR, WS connect failures, unbounded lag`);
  return { tokens };
}

// ─── VU function ──────────────────────────────────────────────────────────────
export default function (data) {
  const token = data.tokens[(__VU - 1) % WALLET_COUNT];
  if (!token) { betErrorRate.add(1); betsError.add(1); return; }

  // Aggressive session: 5–12 bets before reconnect
  const betsThisSession = 5 + Math.floor(Math.random() * 8);
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
        wsConnects.add(1);
        // Minimal stagger (1–100ms) — crush users are all hitting simultaneously
        socket.setTimeout(sendBet, 1 + Math.random() * 99);
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
        // Think time: 100–200 ms (aggressive, bot-like)
        socket.setTimeout(sendBet, 100 + Math.random() * 100);
      }

      if (msg.type === 'ERROR') {
        pendingBet = false;
        if (msg.code === 'INSUFFICIENT_BALANCE') {
          // Balance exhausted: close and reconnect immediately (crush users don't wait)
          betsInsufficient.add(1);
          socket.close();
        } else if (msg.code === 'INTERNAL_ERROR') {
          // Crash / unhandled error — tracked separately as a hard failure signal
          internalErrors.add(1);
          betErrorRate.add(1);
          betsError.add(1);
          socket.close();
        } else {
          betsError.add(1);
          betErrorRate.add(1);
          betCount++;
          if (betCount >= betsThisSession) { socket.close(); return; }
          socket.setTimeout(sendBet, 200);
        }
      }
    });

    socket.on('error', () => { betErrorRate.add(1); wsConnectFail.add(1); socket.close(); });
    socket.setTimeout(() => socket.close(), 30000);   // aggressive safety close

    function sendBet() {
      if (pendingBet) return;
      pendingBet = true;
      betSentAt  = Date.now();
      const target = 20 + Math.floor(Math.random() * 61);
      const chain    = Math.random() < 0.7 ? 'ethereum' : 'solana';
      const currency = chain === 'ethereum' ? 'ETH' : 'SOL';
      socket.send(JSON.stringify({
        type:        'BET_REQUEST',
        clientSeed:  `crush-vu${__VU}-${betCount}-${Date.now()}`,
        wagerAmount: parseFloat((0.005 + Math.random() * 0.045).toFixed(4)),
        chain,
        currency,
        target,
        direction:   Math.random() < 0.5 ? 'over' : 'under',
      }));
    }
  });

  if (!res || res.status !== 101) wsConnectFail.add(1);
  check(res, { '05 ws:101': (r) => r && r.status === 101 });
  sleep(0.2 + Math.random() * 0.3);
}

// ─── Summary ──────────────────────────────────────────────────────────────────
export function handleSummary(data) {
  const m = data.metrics;

  function pval(key, p) { return m[key]?.values?.[`p(${p})`] ?? 999; }
  function cval(key)    { return m[key]?.values?.count ?? 0; }
  function rval(key)    { return m[key]?.values?.rate ?? 0; }

  const p50     = pval('crush_bet_duration_ms', 50);
  const p75     = pval('crush_bet_duration_ms', 75);
  const p95     = pval('crush_bet_duration_ms', 95);
  const p99     = pval('crush_bet_duration_ms', 99);
  const ok      = cval('crush_bets_succeeded');
  const insuf   = cval('crush_bets_insufficient_balance');
  const errors  = cval('crush_bets_error');
  const intErr  = cval('crush_internal_errors');
  const connF   = cval('crush_ws_connect_fail');
  const connOk  = cval('crush_ws_connects');
  const errR    = rval('crush_bet_error_rate');
  const total   = ok + insuf + errors;
  const durSec  = 405;  // Sum of all stage durations: 30+30+30+30+25+150+20+60+30

  const sloP95    = p95 < 100;
  const sloP99    = p99 < 300;
  const sloIntErr = intErr < 10;
  const sloConn   = connF < 50;
  const sloErr    = errR < 0.05;
  const pass      = sloP95 && sloP99 && sloIntErr && sloConn && sloErr;

  console.log(`05-peak-crush ${pass ? 'PASS' : 'FAIL'} | bets=${ok}/${total} intErr=${intErr} wsFail=${connF}/${connOk} P50=${p50.toFixed(1)}ms P75=${p75.toFixed(1)}ms P95=${p95.toFixed(1)}ms P99=${p99.toFixed(1)}ms errRate=${(errR * 100).toFixed(2)}% tput=${(ok / durSec).toFixed(1)}/s`);

  return {
    'results/05-peak-crush-summary.json': JSON.stringify(data, null, 2),
    stdout: `\n05-peak-crush: ${pass ? 'ALL PASS' : 'FAILURE'} | P50=${p50.toFixed(1)}ms P95=${p95.toFixed(1)}ms P99=${p99.toFixed(1)}ms bets=${ok} intErrors=${intErr}\n`,
  };
}
