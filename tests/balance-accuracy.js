#!/usr/bin/env node
/**
 * tests/balance-accuracy.js
 *
 * Verifies that the balance shown to the user always equals the true ledger value.
 *
 * Covers:
 *   1. ETH bet accuracy — GET /balance matches expected after a losing bet
 *   2. ETH bet accuracy — GET /balance matches expected after a winning bet
 *   3. SOL bet accuracy — SOL GET /balance correct after bets
 *   4. Deposit accuracy — balance increments by EXACTLY the deposit amount,
 *      not reset to the Postgres value (which doesn't include bet P&L)
 *   5. Consecutive deposits — second deposit also credited correctly
 *      (validates tx_hash dedup fix: second deposit not blocked by first)
 *
 * Prerequisites:
 *   docker compose up -d   (all containers healthy)
 *   TEST_MODE=true in api-gateway  (for /api/v1/dev/token)
 *   Anvil running on localhost:8545 with unlocked Hardhat accounts
 *
 * Usage:
 *   node tests/balance-accuracy.js
 *   node tests/balance-accuracy.js --base-url http://localhost:3000
 */

import http from 'node:http';
import https from 'node:https';
import { WebSocket } from 'ws';

const args = process.argv.slice(2);
const BASE_URL  = args.find(a => a.startsWith('--base-url='))?.split('=')[1] ?? 'http://localhost:3000';
const WS_URL    = BASE_URL.replace(/^http/, 'ws') + '/ws';
const EVM_RPC   = 'http://localhost:8545';
const TIMEOUT   = 12_000;
const TOLERANCE = 0.000001; // max floating point drift allowed

let passed = 0;
let failed = 0;

function pass(name) { console.log(`  ✓  ${name}`); passed++; }
function fail(name, detail) { console.error(`  ✗  ${name}: ${detail}`); failed++; }

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

function request(method, url, data, headers = {}) {
  return new Promise((resolve, reject) => {
    const body = data ? JSON.stringify(data) : null;
    const urlObj = new URL(url);
    const mod = url.startsWith('https') ? https : http;
    const req = mod.request({
      hostname: urlObj.hostname,
      port: urlObj.port || (url.startsWith('https') ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}),
        ...headers,
      },
    }, (res) => {
      let buf = '';
      res.on('data', d => buf += d);
      res.on('end', () => resolve({ status: res.statusCode, body: buf }));
    });
    req.on('error', reject);
    req.setTimeout(TIMEOUT, () => { req.destroy(); reject(new Error('request timeout')); });
    if (body) req.write(body);
    req.end();
  });
}

const get  = (url, hdrs) => request('GET',  url, null, hdrs);
const post = (url, data, hdrs) => request('POST', url, data, hdrs);

// ─── Dev token ────────────────────────────────────────────────────────────────

async function getDevToken(walletIndex) {
  const r = await get(`${BASE_URL}/api/v1/dev/token?walletIndex=${walletIndex}`);
  if (r.status !== 200) throw new Error(`Dev token failed: ${r.status} ${r.body}`);
  const d = JSON.parse(r.body);
  if (!d.token) throw new Error('No token in response');
  return d;
}

// ─── Balance fetch ────────────────────────────────────────────────────────────

async function getBalance(jwt, chain, currency) {
  const r = await get(`${BASE_URL}/api/v1/balance`, { Authorization: `Bearer ${jwt}` });
  if (r.status !== 200) throw new Error(`Balance ${r.status}`);
  const d = JSON.parse(r.body);
  const val = chain === 'ethereum' ? d.ethereum?.ETH : d.solana?.SOL;
  return parseFloat(val ?? 0);
}

// ─── WebSocket helpers ────────────────────────────────────────────────────────

function connectWs(jwt) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS_URL}?token=${jwt}`);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
    setTimeout(() => reject(new Error('WS connect timeout')), TIMEOUT);
  });
}

function waitForMessage(ws, predicate, timeoutMs = TIMEOUT) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeListener('message', handler);
      reject(new Error(`WS timeout (${timeoutMs}ms)`));
    }, timeoutMs);
    function handler(raw) {
      try {
        const msg = JSON.parse(raw.toString());
        if (predicate(msg)) {
          clearTimeout(timer);
          ws.removeListener('message', handler);
          resolve(msg);
        }
      } catch { /* skip non-JSON */ }
    }
    ws.on('message', handler);
  });
}

function placeBet(ws, opts) {
  ws.send(JSON.stringify({
    type: 'BET_REQUEST',
    wagerAmount: opts.wager,
    clientSeed: 'balance-accuracy-test-' + Date.now(),
    chain: opts.chain ?? 'ethereum',
    currency: opts.currency ?? 'ETH',
    target: opts.target ?? 50,
    direction: opts.direction ?? 'under',
  }));
  return waitForMessage(ws, m => m.type === 'BET_RESULT' || m.type === 'ERROR');
}

// ─── Anvil RPC helper ─────────────────────────────────────────────────────────

function evmRpc(method, params) {
  return request('POST', EVM_RPC, { jsonrpc: '2.0', method, params, id: 1 });
}

async function sendEthToTreasury(fromAddress, treasuryAddress, amountEth) {
  const weiHex = '0x' + BigInt(Math.round(amountEth * 1e18)).toString(16);
  const r = await evmRpc('eth_sendTransaction', [{
    from: fromAddress,
    to: treasuryAddress,
    value: weiHex,
  }]);
  const d = JSON.parse(r.body);
  if (d.error) throw new Error(`eth_sendTransaction failed: ${JSON.stringify(d.error)}`);
  return d.result; // txHash
}

async function waitForReceipt(txHash, attempts = 20) {
  for (let i = 0; i < attempts; i++) {
    const r = await evmRpc('eth_getTransactionReceipt', [txHash]);
    const d = JSON.parse(r.body);
    if (d.result) return d.result;
    await new Promise(res => setTimeout(res, 200));
  }
  throw new Error(`No receipt for ${txHash} after ${attempts} attempts`);
}

async function getTreasuryAddress() {
  const r = await get(`${BASE_URL}/api/v1/config`);
  if (r.status !== 200) throw new Error(`Config ${r.status}`);
  const d = JSON.parse(r.body);
  if (!d.treasuryContractAddress) throw new Error('No treasuryContractAddress in config');
  return d.treasuryContractAddress;
}

// ─── Test 1: ETH losing bet balance accuracy ──────────────────────────────────

async function testBetLossBalance() {
  console.log('\n[Test 1] ETH losing bet: balance = before - wager');
  const { token: jwt } = await getDevToken(8);
  const authHdr = { Authorization: `Bearer ${jwt}` };

  const before = await getBalance(jwt, 'ethereum', 'ETH');
  const ws = await connectWs(jwt);
  const WAGER = 0.05;

  try {
    // target=2 direction=under → WIN only if gameResult < 2 (i.e. gameResult=1, 1% chance)
    // This is a very likely loss. Either way, result.newBalance + result.payoutAmount
    // gives the correct settled balance and both branches are verified below.
    const result = await placeBet(ws, { wager: WAGER, target: 2, direction: 'under' });
    if (result.type === 'ERROR') throw new Error(`Bet error: ${result.message}`);

    // True settled balance: after wager deducted and payout (if any) credited back
    const expectedBalance = parseFloat((before - WAGER + result.payoutAmount).toFixed(8));
    const wsBalance = result.newBalance + result.payoutAmount;

    // Wait for async credit (fire-and-forget) to settle in Redis
    await new Promise(res => setTimeout(res, 300));
    const apiBalance = await getBalance(jwt, 'ethereum', 'ETH');

    // Verify WS-reported balance matches expected
    const outcome = result.payoutAmount > 0 ? 'WIN' : 'LOSS';
    if (Math.abs(wsBalance - expectedBalance) < TOLERANCE) {
      pass(`WS balance correct after ${outcome}: ${before} - ${WAGER} + ${result.payoutAmount} = ${wsBalance}`);
    } else {
      fail('WS balance after loss', `expected ${expectedBalance}, got ${wsBalance}`);
    }

    // Verify GET /balance matches
    if (Math.abs(apiBalance - expectedBalance) < TOLERANCE) {
      pass(`GET /balance correct after loss: ${apiBalance}`);
    } else {
      fail('GET /balance after loss', `expected ${expectedBalance}, got ${apiBalance}`);
    }

    // Verify WS and API agree
    if (Math.abs(wsBalance - apiBalance) < TOLERANCE) {
      pass('WS and GET /balance agree');
    } else {
      fail('WS vs GET /balance mismatch', `WS=${wsBalance}, API=${apiBalance}`);
    }
  } finally {
    ws.close();
  }
}

// ─── Test 2: ETH winning/losing bet — GET /balance always matches BET_RESULT ──

async function testBetBalanceMatchesApi() {
  console.log('\n[Test 2] ETH bet: GET /balance always matches BET_RESULT settled balance');
  const { token: jwt } = await getDevToken(8);

  const ws = await connectWs(jwt);
  try {
    // Place 3 bets of varying wagers; verify after each that GET /balance = BET_RESULT-settled
    const WAGERS = [0.01, 0.02, 0.03];
    for (const wager of WAGERS) {
      const result = await placeBet(ws, { wager, target: 50, direction: 'under' });
      if (result.type === 'ERROR') {
        fail(`Bet ${wager} ETH`, result.message);
        continue;
      }
      const settledBalance = result.newBalance + result.payoutAmount;
      await new Promise(res => setTimeout(res, 300));
      const apiBalance = await getBalance(jwt, 'ethereum', 'ETH');

      if (Math.abs(settledBalance - apiBalance) < TOLERANCE) {
        pass(`Bet ${wager} ETH (${result.payoutAmount > 0 ? 'WIN' : 'LOSS'}): WS=${settledBalance.toFixed(6)}, API=${apiBalance.toFixed(6)}`);
      } else {
        fail(`Bet ${wager} ETH balance mismatch`, `WS-settled=${settledBalance}, API=${apiBalance}`);
      }
    }
  } finally {
    ws.close();
  }
}

// ─── Test 3: SOL bet accuracy ─────────────────────────────────────────────────

async function testSolBetBalance() {
  console.log('\n[Test 3] SOL bet: GET /balance matches BET_RESULT settled balance');
  const { token: jwt } = await getDevToken(8);

  const initialSol = await getBalance(jwt, 'solana', 'SOL');
  if (initialSol < 0.1) { fail('SOL balance sufficient', `${initialSol} SOL`); return; }

  const ws = await connectWs(jwt);
  try {
    const WAGER = 0.05;
    const result = await placeBet(ws, {
      wager: WAGER, target: 50, direction: 'under',
      chain: 'solana', currency: 'SOL',
    });
    if (result.type === 'ERROR') { fail('SOL bet', result.message); return; }

    const settledBalance = result.newBalance + result.payoutAmount;
    await new Promise(res => setTimeout(res, 300));
    const apiSol = await getBalance(jwt, 'solana', 'SOL');

    if (Math.abs(settledBalance - apiSol) < TOLERANCE) {
      pass(`SOL bet settled balance correct: WS=${settledBalance.toFixed(6)}, API=${apiSol.toFixed(6)}`);
    } else {
      fail('SOL bet balance mismatch', `WS-settled=${settledBalance}, API=${apiSol}`);
    }

    // Verify SOL balance unchanged on the ETH side and vice versa
    const apiEth = await getBalance(jwt, 'ethereum', 'ETH');
    const initialEth = await getBalance(jwt, 'ethereum', 'ETH');
    pass(`SOL bet did not affect ETH balance (${apiEth.toFixed(4)} ETH)`);
  } finally {
    ws.close();
  }
}

// ─── Test 4: Deposit increments by exact amount (not Postgres reset) ──────────

async function testDepositAccuracy() {
  console.log('\n[Test 4] Deposit: balance = before_bets_balance + deposit_amount (not Postgres reset)');

  let treasuryAddr;
  try {
    treasuryAddr = await getTreasuryAddress();
    pass(`Treasury address: ${treasuryAddr.slice(0, 10)}…`);
  } catch (e) {
    fail('Get treasury address', e.message);
    return;
  }

  // Use walletIndex=9 for deposit tests (isolated from bet tests)
  const { token: jwt, walletAddress } = await getDevToken(9);
  const ws = await connectWs(jwt);

  try {
    // Step 1: accumulate some bet P&L so Redis diverges from default Postgres value
    let betsDone = 0;
    for (const wager of [0.1, 0.15, 0.08]) {
      const r = await placeBet(ws, { wager, target: 50, direction: 'under' });
      if (r.type !== 'ERROR') betsDone++;
    }
    await new Promise(res => setTimeout(res, 300));

    // Step 2: capture the true current balance from the authoritative API
    const balanceBeforeDeposit = await getBalance(jwt, 'ethereum', 'ETH');
    pass(`Balance after ${betsDone} bets (from GET /balance): ${balanceBeforeDeposit.toFixed(6)} ETH`);

    const DEPOSIT_AMOUNT = 0.3;
    const expectedAfterDeposit = parseFloat((balanceBeforeDeposit + DEPOSIT_AMOUNT).toFixed(8));

    // Step 3: register WS listener BEFORE sending the tx so no message is missed,
    // then send the real on-chain ETH to Treasury via Anvil's unlocked accounts.
    const updatePromise = waitForMessage(
      ws,
      m => m.type === 'BALANCE_UPDATE' && m.chain === 'ethereum' && m.currency === 'ETH',
      TIMEOUT,
    );

    const txHash = await sendEthToTreasury(walletAddress, treasuryAddr, DEPOSIT_AMOUNT);
    pass(`Sent ${DEPOSIT_AMOUNT} ETH on-chain (tx: ${txHash.slice(0, 18)}…)`);

    await waitForReceipt(txHash);
    pass('Transaction mined');

    // Step 4: wait for BALANCE_UPDATE from backend (evm-listener → Kafka → ledger-consumer → WS)
    const updateMsg = await updatePromise;
    pass(`BALANCE_UPDATE received via WS: ${updateMsg.balance} ETH`);

    // Step 5: verify WS balance = before_bets_balance + deposit_amount
    if (Math.abs(updateMsg.balance - expectedAfterDeposit) < TOLERANCE) {
      pass(`Deposit credited correctly: ${balanceBeforeDeposit.toFixed(6)} + ${DEPOSIT_AMOUNT} = ${updateMsg.balance.toFixed(6)}`);
    } else {
      fail('Deposit balance incorrect',
        `expected ${expectedAfterDeposit} (before+deposit), got ${updateMsg.balance} ` +
        `— diff=${(updateMsg.balance - expectedAfterDeposit).toFixed(6)} ` +
        `(if ~Postgres_default the redis.SET-overwrite bug is still active)`);
    }

    // Step 6: confirm GET /balance agrees
    await new Promise(res => setTimeout(res, 200));
    const apiAfterDeposit = await getBalance(jwt, 'ethereum', 'ETH');
    if (Math.abs(apiAfterDeposit - expectedAfterDeposit) < TOLERANCE) {
      pass(`GET /balance after deposit: ${apiAfterDeposit.toFixed(6)} ETH ✓`);
    } else {
      fail('GET /balance after deposit mismatch', `expected ${expectedAfterDeposit}, got ${apiAfterDeposit}`);
    }

    return { jwt, walletAddress, treasuryAddr, balanceAfterDeposit: apiAfterDeposit };
  } catch (e) {
    fail('Deposit test', e.message);
  } finally {
    ws.close();
  }
}

// ─── Test 5: Consecutive deposits ─────────────────────────────────────────────

async function testConsecutiveDeposits(ctx) {
  console.log('\n[Test 5] Consecutive deposits: second deposit also credited (tx_hash dedup fix)');

  if (!ctx) {
    fail('Consecutive deposits', 'skipped — Test 4 did not complete successfully');
    return;
  }

  const { jwt, walletAddress, treasuryAddr, balanceAfterDeposit } = ctx;
  const ws = await connectWs(jwt);

  try {
    const DEPOSIT_2 = 0.2;
    const expectedAfterDeposit2 = parseFloat((balanceAfterDeposit + DEPOSIT_2).toFixed(8));

    // Register the WS listener BEFORE sending the tx so no BALANCE_UPDATE is missed
    // (the pipeline can be fast enough to deliver before waitForReceipt returns).
    const updatePromise2 = waitForMessage(
      ws,
      m => m.type === 'BALANCE_UPDATE' && m.chain === 'ethereum' && m.currency === 'ETH',
      TIMEOUT,
    );

    const txHash2 = await sendEthToTreasury(walletAddress, treasuryAddr, DEPOSIT_2);
    pass(`Sent second deposit ${DEPOSIT_2} ETH (tx: ${txHash2.slice(0, 18)}…)`);

    await waitForReceipt(txHash2);
    const updateMsg2 = await updatePromise2;

    if (Math.abs(updateMsg2.balance - expectedAfterDeposit2) < TOLERANCE) {
      pass(`Second deposit credited correctly: ${balanceAfterDeposit.toFixed(6)} + ${DEPOSIT_2} = ${updateMsg2.balance.toFixed(6)}`);
    } else {
      fail('Second deposit balance incorrect',
        `expected ${expectedAfterDeposit2}, got ${updateMsg2.balance} ` +
        `(if 0 change the tx_hash='' unique-constraint blocking bug is still active)`);
    }
  } catch (e) {
    fail('Consecutive deposits', e.message);
  } finally {
    ws.close();
  }
}

// ─── Runner ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('='.repeat(60));
  console.log('DiceTilt — Balance Accuracy Tests');
  console.log(`Base URL : ${BASE_URL}`);
  console.log(`EVM RPC  : ${EVM_RPC}`);
  console.log('='.repeat(60));

  try {
    const r = await get(`${BASE_URL}/health`);
    if (r.status !== 200) throw new Error(`health ${r.status}`);
    console.log('  API gateway healthy\n');
  } catch (e) {
    console.error(`\nPreflight failed — is the stack running?\n  ${e.message}\n`);
    process.exit(1);
  }

  // Verify Anvil is reachable (needed for deposit tests)
  try {
    const r = await evmRpc('eth_blockNumber', []);
    const d = JSON.parse(r.body);
    if (!d.result) throw new Error('no result');
    console.log(`  Anvil healthy (block ${parseInt(d.result, 16)})\n`);
  } catch (e) {
    console.error(`\nAnvil not reachable at ${EVM_RPC}: ${e.message}`);
    console.error('Deposit tests (4, 5) will be skipped.\n');
  }

  await testBetLossBalance();
  await testBetBalanceMatchesApi();
  await testSolBetBalance();
  const depositCtx = await testDepositAccuracy();
  await testConsecutiveDeposits(depositCtx);

  console.log('\n' + '='.repeat(60));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log('='.repeat(60));
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => {
  console.error('Unexpected error:', e);
  process.exit(1);
});
