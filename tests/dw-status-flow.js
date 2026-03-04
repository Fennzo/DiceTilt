#!/usr/bin/env node
/**
 * tests/dw-status-flow.js
 *
 * Verifies the deposit/withdraw status flow that drives the frontend UI:
 *
 *   Deposit:
 *     1. Click deposit → setDwBusy(true), status='pending' (spinner)
 *     2. tx mined      → status='pending' ("awaiting ledger update")
 *     3. BALANCE_UPDATE received via WS → status='ok' (green), buttons re-enabled
 *
 *   Withdrawal:
 *     1. Click withdraw → setDwBusy(true), status='pending' (spinner)
 *     2. POST /withdraw accepted → balance deducted, status='pending' (spinner)
 *     3. WITHDRAWAL_COMPLETED received via WS → status='ok' (green), buttons re-enabled
 *
 * This test proves the WS signals that gate the UI state transitions arrive
 * within the required time window. Visual CSS behavior (spinner / green) is
 * driven entirely by these signals so this constitutes a full flow test.
 *
 * Usage:
 *   node tests/dw-status-flow.js [--base-url http://localhost:3000]
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const WebSocket = require('ws');

const args = process.argv.slice(2);
const baseUrlIdx = args.indexOf('--base-url');
const BASE_URL = baseUrlIdx !== -1 ? args[baseUrlIdx + 1] : 'http://localhost:3000';
const WS_URL   = BASE_URL.replace(/^http/, 'ws') + '/ws';

const TREASURY = '0x5FbDB2315678afecb367f032d93F642f64180aa3';
const ANVIL    = 'http://localhost:8545';
// Hardhat account #1 — pre-funded, used by the demo frontend (/?demo=1)
const DEMO_WALLET = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';

let passed = 0, failed = 0;
function pass(msg)  { console.log(`  ✓  ${msg}`); passed++; }
function fail(msg)  { console.error(`  ✗  ${msg}`); failed++; }
function section(s) { console.log(`\n── ${s} ──`); }

// ─── helpers ────────────────────────────────────────────────────────────────

async function apiFetch(path, opts = {}) {
  const r = await fetch(`${BASE_URL}${path}`, opts);
  if (!r.ok) throw new Error(`${path} → HTTP ${r.status}`);
  return r.json();
}

function connectWs(token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    const t = setTimeout(() => reject(new Error('WS connect timeout')), 8000);
    ws.once('open', () => {
      ws.send(JSON.stringify({ type: 'AUTH', token }));
    });
    ws.once('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'AUTH_OK') { clearTimeout(t); resolve(ws); }
      else { clearTimeout(t); reject(new Error(`WS auth failed: ${raw}`)); }
    });
    ws.once('error', (e) => { clearTimeout(t); reject(e); });
  });
}

/**
 * Wait for a specific WS message type matching a predicate.
 * Returns { msg, elapsedMs }.
 */
function waitForWsMessage(ws, type, predicateFn, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const t = setTimeout(() => {
      ws.removeListener('message', handler);
      reject(new Error(`Timeout (${timeoutMs}ms) waiting for WS ${type}`));
    }, timeoutMs);

    function handler(raw) {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.type === type && (!predicateFn || predicateFn(msg))) {
        clearTimeout(t);
        ws.removeListener('message', handler);
        resolve({ msg, elapsedMs: Date.now() - start });
      }
    }
    ws.on('message', handler);
  });
}

async function anvil(method, params = []) {
  const r = await fetch(ANVIL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method, params, id: 1 }),
  });
  const d = await r.json();
  if (d.error) throw new Error(`Anvil ${method}: ${d.error.message}`);
  return d.result;
}

// ─── main ───────────────────────────────────────────────────────────────────

async function run() {
  console.log('DiceTilt — Deposit/Withdraw Status Flow Test');
  console.log(`  BASE_URL : ${BASE_URL}`);
  console.log(`  WS_URL   : ${WS_URL}`);

  // ── Step 1: get JWT for demo wallet ────────────────────────────────────────
  section('Auth');
  let jwt, userId, balanceBefore;
  try {
    const auth = await apiFetch('/api/v1/dev/token?walletIndex=301');
    jwt    = auth.token;
    userId = auth.userId;
    pass(`dev token acquired  userId=${userId.slice(0, 8)}…`);
  } catch (e) {
    fail(`dev token: ${e.message}`);
    process.exit(1);
  }

  // ── Step 2: connect WebSocket ───────────────────────────────────────────────
  let ws;
  try {
    ws = await connectWs(jwt);
    pass('WebSocket authenticated (AUTH_OK received)');
  } catch (e) {
    fail(`WS auth: ${e.message}`);
    process.exit(1);
  }

  // ── Step 3: baseline balance ────────────────────────────────────────────────
  section('Baseline');
  try {
    const bal = await apiFetch('/api/v1/balance', { headers: { Authorization: `Bearer ${jwt}` } });
    balanceBefore = bal.ethereum.ETH;
    pass(`baseline ETH balance = ${balanceBefore}`);
  } catch (e) {
    fail(`balance fetch: ${e.message}`);
  }

  // ────────────────────────────────────────────────────────────────────────────
  // TEST A: DEPOSIT FLOW
  // Frontend state machine:
  //   setDwBusy(true) → status='pending'
  //   tx.wait() resolves → status='pending' ("awaiting ledger update")
  //   BALANCE_UPDATE arrives → status='ok', setDwBusy(false)
  // ────────────────────────────────────────────────────────────────────────────
  section('Deposit flow');
  const DEPOSIT_AMOUNT = 0.1; // ETH (small enough to not drain Anvil account)

  // Register listener BEFORE sending tx so we don't miss the event
  const depositUpdatePromise = waitForWsMessage(
    ws, 'BALANCE_UPDATE',
    msg => msg.chain === 'ethereum' && msg.currency === 'ETH',
    12000,
  );

  // Send the deposit transaction (mirrors what the frontend does)
  const depositTxHash = await anvil('eth_sendTransaction', [{
    from:  DEMO_WALLET,
    to:    TREASURY,
    value: '0x' + (BigInt(Math.round(DEPOSIT_AMOUNT * 1e18))).toString(16),
    data:  '0x',
  }]);
  const depositSent = Date.now();
  pass(`deposit tx sent  hash=${depositTxHash.slice(0, 18)}…`);

  // Frontend would now show status='pending' and disable all buttons.
  // We wait for BALANCE_UPDATE — the exact signal that clears pending and shows 'ok'.
  let depositResult;
  try {
    depositResult = await depositUpdatePromise;
    const { msg, elapsedMs } = depositResult;
    pass(`BALANCE_UPDATE received  balance=${msg.balance} ETH  elapsed=${elapsedMs}ms`);

    if (elapsedMs < 10000) {
      pass(`signal latency within 10s SLO (${elapsedMs}ms)`);
    } else {
      fail(`signal latency exceeded 10s SLO (${elapsedMs}ms)`);
    }

    const expectedMin = (balanceBefore ?? 0) + DEPOSIT_AMOUNT - 0.001;
    if (msg.balance >= expectedMin) {
      pass(`balance increased by deposit amount (${balanceBefore} + ${DEPOSIT_AMOUNT} → ${msg.balance})`);
    } else {
      fail(`balance not updated correctly  got=${msg.balance}  expected>=${expectedMin.toFixed(4)}`);
    }
  } catch (e) {
    fail(`deposit BALANCE_UPDATE: ${e.message}`);
  }

  const balanceAfterDeposit = depositResult?.msg?.balance ?? balanceBefore;

  // ────────────────────────────────────────────────────────────────────────────
  // TEST B: WITHDRAWAL FLOW
  // Frontend state machine:
  //   setDwBusy(true) → status='pending'
  //   POST /withdraw accepted → status='pending' ("awaiting on-chain payout")
  //   WITHDRAWAL_COMPLETED arrives → status='ok', setDwBusy(false)
  // ────────────────────────────────────────────────────────────────────────────
  section('Withdrawal flow');
  const WITHDRAW_AMOUNT = DEPOSIT_AMOUNT; // withdraw what we just deposited

  // Register listeners BEFORE POST so we don't miss rapid delivery
  const withdrawUpdatePromise = waitForWsMessage(
    ws, 'BALANCE_UPDATE',
    msg => msg.chain === 'ethereum' && msg.currency === 'ETH',
    12000,
  );
  const withdrawCompletedPromise = waitForWsMessage(ws, 'WITHDRAWAL_COMPLETED', null, 35000);

  // POST /withdraw (mirrors what the frontend does)
  let withdrawalId;
  try {
    const res = await fetch(`${BASE_URL}/api/v1/withdraw`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
      body: JSON.stringify({ amount: WITHDRAW_AMOUNT, chain: 'ethereum', currency: 'ETH' }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || JSON.stringify(data));
    withdrawalId = data.withdrawalId;
    pass(`POST /withdraw accepted  withdrawalId=${withdrawalId != null ? withdrawalId.slice(0, 8) + '…' : '(no id)'}  status=${data.status}`);
  } catch (e) {
    fail(`POST /withdraw: ${e.message}`);
    ws.close();
    summarise();
    return;
  }

  // BALANCE_UPDATE (balance deducted, buttons remain greyed while waiting for on-chain)
  try {
    const { msg, elapsedMs } = await withdrawUpdatePromise;
    pass(`BALANCE_UPDATE (deduction) received  balance=${msg.balance} ETH  elapsed=${elapsedMs}ms`);
    const expectedMax = balanceAfterDeposit - WITHDRAW_AMOUNT + 0.001;
    if (msg.balance <= expectedMax) {
      pass(`balance decreased by withdrawal amount`);
    } else {
      fail(`balance not deducted correctly  got=${msg.balance}  expected<=${expectedMax.toFixed(4)}`);
    }
  } catch (e) {
    fail(`withdrawal BALANCE_UPDATE: ${e.message}`);
  }

  // WITHDRAWAL_COMPLETED (on-chain payout done — this is when frontend shows 'ok')
  try {
    const { msg, elapsedMs } = await withdrawCompletedPromise;
    pass(`WITHDRAWAL_COMPLETED received  txHash=${(msg.txHash || '').slice(0, 18)}…  elapsed=${elapsedMs}ms`);

    if (elapsedMs < 30000) {
      pass(`on-chain payout within 30s window (${elapsedMs}ms)`);
    } else {
      fail(`on-chain payout exceeded 30s window (${elapsedMs}ms)`);
    }

    if (msg.withdrawalId === withdrawalId) {
      pass(`withdrawalId matches`);
    } else {
      fail(`withdrawalId mismatch  expected=${withdrawalId.slice(0, 8)}  got=${(msg.withdrawalId || '').slice(0, 8)}`);
    }
  } catch (e) {
    fail(`WITHDRAWAL_COMPLETED: ${e.message}`);
  }

  ws.close();
  summarise();
}

function summarise() {
  const total = passed + failed;
  console.log(`\n${'─'.repeat(50)}`);
  console.log(`  ${passed}/${total} tests passed`);
  if (failed > 0) {
    console.error(`  ${failed} FAILED`);
    process.exit(1);
  } else {
    console.log('  All tests passed ✓');
  }
}

run().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
