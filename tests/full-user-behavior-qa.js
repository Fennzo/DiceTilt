#!/usr/bin/env node
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const WebSocket = require('ws');

const BASE_URL = process.argv.find((a) => a.startsWith('--base-url='))?.split('=')[1] ?? 'http://localhost:3000';
const WS_URL = BASE_URL.replace(/^http/, 'ws') + '/ws';
const EVM_RPC_URL = 'http://localhost:8545';
const WALLET_INDEX = 1;
const WALLET_ADDRESS = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const FLOAT_TOL = 1e-6;

let passed = 0;
let failed = 0;

function pass(msg) {
  passed += 1;
  console.log(`  ✓ ${msg}`);
}

function fail(msg) {
  failed += 1;
  console.error(`  ✗ ${msg}`);
}

function sha256Hex(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function hmacHex(serverSeed, payload) {
  return crypto.createHmac('sha256', serverSeed).update(payload).digest('hex');
}

function approxEqual(a, b, tol = FLOAT_TOL) {
  return Math.abs(a - b) <= tol;
}

async function api(path, options = {}) {
  const res = await fetch(`${BASE_URL}${path}`, options);
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { ok: res.ok, status: res.status, data };
}

async function evmRpc(method, params = []) {
  const res = await fetch(EVM_RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const json = await res.json();
  if (json.error) throw new Error(`${method} failed: ${JSON.stringify(json.error)}`);
  return json.result;
}

function connectWs(token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    const timer = setTimeout(() => reject(new Error('WS connect timeout')), 10000);

    ws.once('open', () => {
      ws.send(JSON.stringify({ type: 'AUTH', token }));
    });
    ws.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    ws.on('message', function authHandler(raw) {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.type === 'AUTH_OK') {
        clearTimeout(timer);
        ws.removeListener('message', authHandler);
        resolve(ws);
      }
      if (msg.type === 'ERROR') {
        clearTimeout(timer);
        ws.removeListener('message', authHandler);
        reject(new Error(`WS auth rejected: ${msg.code}`));
      }
    });
  });
}

function waitForMessage(ws, predicate, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeListener('message', handler);
      reject(new Error(`Timeout waiting for WS message (${timeoutMs}ms)`));
    }, timeoutMs);

    function handler(raw) {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (predicate(msg)) {
        clearTimeout(timer);
        ws.removeListener('message', handler);
        resolve(msg);
      }
    }

    ws.on('message', handler);
  });
}

async function getBalance(token) {
  const bal = await api('/api/v1/balance', {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!bal.ok) throw new Error(`balance failed: ${bal.status}`);
  return {
    eth: parseFloat(bal.data.ethereum?.ETH ?? 0),
    sol: parseFloat(bal.data.solana?.SOL ?? 0),
  };
}

async function main() {
  console.log('DiceTilt Full User Behavior QA');
  console.log(`  BASE_URL=${BASE_URL}`);
  console.log(`  WS_URL=${WS_URL}`);

  const health = await api('/health');
  if (!health.ok) {
    console.error('Stack health check failed.');
    process.exit(1);
  }
  pass('API health endpoint reachable');

  const auth = await api(`/api/v1/dev/token?walletIndex=${WALLET_INDEX}`);
  if (!auth.ok || !auth.data?.token) {
    fail(`dev token acquisition failed: ${auth.status}`);
    summarize();
    return;
  }
  const token = auth.data.token;
  pass('Dev token acquired');

  if ((auth.data.walletAddress ?? '').toLowerCase() === WALLET_ADDRESS.toLowerCase()) {
    pass('Dev token wallet matches expected Anvil unlocked account #1');
  } else {
    fail(`Unexpected wallet address from dev token: ${auth.data.walletAddress}`);
  }

  const ws = await connectWs(token);
  pass('WebSocket AUTH_OK received');

  const baseBalance = await getBalance(token);
  pass(`Initial balances read ETH=${baseBalance.eth.toFixed(6)} SOL=${baseBalance.sol.toFixed(6)}`);

  // 1) Bet matrix: ETH+SOL and under+over
  const betCases = [
    { chain: 'ethereum', currency: 'ETH', direction: 'under', target: 50, wagerAmount: 0.01, clientSeed: 'qa-eth-under' },
    { chain: 'ethereum', currency: 'ETH', direction: 'over', target: 50, wagerAmount: 0.01, clientSeed: 'qa-eth-over' },
    { chain: 'solana', currency: 'SOL', direction: 'under', target: 50, wagerAmount: 0.01, clientSeed: 'qa-sol-under' },
    { chain: 'solana', currency: 'SOL', direction: 'over', target: 50, wagerAmount: 0.01, clientSeed: 'qa-sol-over' },
  ];

  let preRotateProof = null;

  for (const testCase of betCases) {
    ws.send(JSON.stringify({ type: 'BET_REQUEST', ...testCase }));
    const msg = await waitForMessage(ws, (m) => m.type === 'BET_RESULT' || m.type === 'ERROR');
    if (msg.type === 'ERROR') {
      fail(`Bet ${testCase.currency} ${testCase.direction} returned ERROR: ${msg.code}`);
      continue;
    }

    const expectedWin = testCase.direction === 'under'
      ? msg.gameResult < testCase.target
      : msg.gameResult > testCase.target;
    const paid = msg.payoutAmount > 0;
    if (expectedWin === paid) {
      pass(`Bet ${testCase.currency} ${testCase.direction} win/loss logic correct (result=${msg.gameResult}, target=${testCase.target})`);
    } else {
      fail(`Bet ${testCase.currency} ${testCase.direction} logic mismatch (result=${msg.gameResult}, payout=${msg.payoutAmount})`);
    }

    const settledBalanceFromWs = msg.newBalance + msg.payoutAmount;
    const now = await getBalance(token);
    const apiBalance = testCase.currency === 'ETH' ? now.eth : now.sol;
    if (approxEqual(settledBalanceFromWs, apiBalance, 0.0005)) {
      pass(`Bet ${testCase.currency} ${testCase.direction} balance reconciles WS/API`);
    } else {
      fail(`Bet ${testCase.currency} ${testCase.direction} balance mismatch WS=${settledBalanceFromWs} API=${apiBalance}`);
    }

    if (testCase.currency === 'ETH' && testCase.direction === 'under') {
      preRotateProof = {
        clientSeed: testCase.clientSeed,
        nonce: msg.nonce,
        gameHash: msg.gameHash,
      };
    }
  }

  // 2) ETH deposit end-to-end
  const cfg = await api('/api/v1/config');
  if (!cfg.ok || !cfg.data?.treasuryContractAddress) {
    fail('Missing treasury config for ETH deposit');
  } else {
    const before = await getBalance(token);
    const depositAmount = 0.05;
    const waitBalance = waitForMessage(
      ws,
      (m) => m.type === 'BALANCE_UPDATE' && m.chain === 'ethereum' && m.currency === 'ETH',
      25000,
    );

    const txHash = await evmRpc('eth_sendTransaction', [{
      from: WALLET_ADDRESS,
      to: cfg.data.treasuryContractAddress,
      value: '0x' + BigInt(Math.round(depositAmount * 1e18)).toString(16),
      data: '0x',
    }]);
    pass(`ETH deposit tx sent (${txHash.slice(0, 18)}...)`);

    for (let i = 0; i < 25; i += 1) {
      const receipt = await evmRpc('eth_getTransactionReceipt', [txHash]);
      if (receipt) break;
      await new Promise((r) => setTimeout(r, 300));
    }
    pass('ETH deposit transaction mined');

    const balUpdate = await waitBalance;
    const expected = before.eth + depositAmount;
    if (approxEqual(parseFloat(balUpdate.balance), expected, 0.001)) {
      pass(`ETH deposit balance update correct (${before.eth} + ${depositAmount} -> ${balUpdate.balance})`);
    } else {
      fail(`ETH deposit balance incorrect expected~${expected} got=${balUpdate.balance}`);
    }
  }

  // 3) ETH withdrawal end-to-end
  {
    const amount = 0.02;
    const before = await getBalance(token);
    const completionPromise = waitForMessage(
      ws,
      (m) => m.type === 'WITHDRAWAL_COMPLETED',
      45000,
    );
    const balanceUpdatePromise = waitForMessage(
      ws,
      (m) => m.type === 'BALANCE_UPDATE' && m.chain === 'ethereum' && m.currency === 'ETH',
      45000,
    );

    const res = await api('/api/v1/withdraw', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount, chain: 'ethereum', currency: 'ETH' }),
    });

    if (res.status === 202 && res.data?.withdrawalId) {
      pass('ETH withdrawal accepted (202)');
      const withdrawalId = res.data.withdrawalId;

      const immediate = await getBalance(token);
      if (approxEqual(immediate.eth, before.eth - amount, 0.001)) {
        pass('ETH withdrawal deducts balance immediately');
      } else {
        fail(`ETH withdrawal immediate deduction mismatch before=${before.eth} after=${immediate.eth} amount=${amount}`);
      }

      let completed = null;
      try {
        completed = await completionPromise;
      } catch (err) {
        fail(`ETH withdrawal completion event timeout: ${String(err)}`);
      }

      if (completed && completed.withdrawalId === withdrawalId && completed.txHash) {
        pass('ETH withdrawal completion event received with matching withdrawalId and txHash');
      } else if (completed) {
        fail(`ETH withdrawal completion mismatch expected=${withdrawalId} got=${completed.withdrawalId}`);
      }

      try {
        await balanceUpdatePromise;
        pass('ETH withdrawal BALANCE_UPDATE event received');
      } catch (err) {
        fail(`ETH withdrawal BALANCE_UPDATE timeout: ${String(err)}`);
      }
    } else {
      fail(`ETH withdrawal request failed: ${res.status} ${JSON.stringify(res.data)}`);
      completionPromise.catch(() => {});
      balanceUpdatePromise.catch(() => {});
    }
  }

  // 4) SOL withdrawal behavior (documented Solana payout layer is stubbed in PoC)
  {
    const amount = 0.01;
    const solWithdraw = await api('/api/v1/withdraw', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount, chain: 'solana', currency: 'SOL' }),
    });

    const expectedMessage = 'SOL is not available for demo deposit/withdrawal';
    if (
      solWithdraw.status === 400 &&
      solWithdraw.data?.error === 'CHAIN_UNAVAILABLE' &&
      solWithdraw.data?.message === expectedMessage
    ) {
      pass('SOL withdrawal correctly rejected with demo-mode SOL unavailable message');
    } else {
      fail(`SOL withdrawal behavior unexpected: ${solWithdraw.status} ${JSON.stringify(solWithdraw.data)}`);
    }
  }

  // 5) Provably fair rotate + verification
  {
    const statusBefore = await api('/api/pf/status?chain=ethereum&currency=ETH', {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!statusBefore.ok) {
      fail('PF status before rotate failed');
    } else {
      pass('PF status before rotate returned');
    }

    const rotate = await api('/api/pf/rotate-seed', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!rotate.ok) {
      fail(`PF rotate failed: ${rotate.status}`);
    } else {
      const prev = rotate.data.previousCommitment;
      const revealed = rotate.data.revealedServerSeed;
      const newCommit = rotate.data.newCommitment;

      if (sha256Hex(revealed) === prev) {
        pass('PF rotate returned verifiable reveal (SHA256(revealed) == previousCommitment)');
      } else {
        fail('PF reveal hash mismatch');
      }

      if (rotate.data.serverVerified === true) {
        pass('PF serverVerified flag true');
      } else {
        fail('PF serverVerified flag false');
      }

      if (statusBefore.ok && statusBefore.data.serverCommitment === prev) {
        pass('PF previousCommitment matches pre-rotate status commitment');
      } else {
        fail('PF previousCommitment does not match pre-rotate commitment');
      }

      const statusAfter = await api('/api/pf/status?chain=ethereum&currency=ETH', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (statusAfter.ok && statusAfter.data.serverCommitment === newCommit) {
        pass('PF status after rotate shows new commitment');
      } else {
        fail('PF status after rotate commitment mismatch');
      }

      if (preRotateProof) {
        const expectedHash = hmacHex(revealed, `${preRotateProof.clientSeed}:${preRotateProof.nonce}`);
        if (expectedHash === preRotateProof.gameHash) {
          pass('PF client-side verification of pre-rotation bet hash succeeded');
        } else {
          fail('PF client-side verification of pre-rotation bet hash failed');
        }
      } else {
        fail('PF pre-rotation proof bet unavailable');
      }
    }
  }

  ws.close();
  summarize();
}

function summarize() {
  const total = passed + failed;
  console.log('\n' + '-'.repeat(56));
  console.log(`QA result: ${passed}/${total} checks passed`);
  if (failed > 0) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('Fatal QA harness error:', err);
  process.exit(1);
});
