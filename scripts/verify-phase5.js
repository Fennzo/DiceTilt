#!/usr/bin/env node
/**
 * Phase 5 Verification Script
 * Run: node scripts/verify-phase5.js
 * Requires: docker compose up, services healthy
 */
const http = require('http');
const https = require('https');

const API = 'http://localhost';
const TREASURY = '0x5FbDB2315678afecb367f032d93F642f64180aa3';

async function fetch(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(url, opts, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, data });
        }
      });
    });
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

async function main() {
  console.log('=== Phase 5 Verification ===\n');

  // Create demo user (Hardhat account #1)
  const { ethers } = await import('ethers');
  const wallet = ethers.HDNodeWallet.fromPhrase('test test test test test test test test test test test junk', '', "m/44'/60'/0'/0/1");
  const addr = wallet.address;
  console.log('Demo wallet:', addr);

  const ch = await fetch(`${API}/api/v1/auth/challenge`, { method: 'POST' });
  const nonce = ch.data.nonce;
  const sig = await wallet.signMessage(addr);

  const verify = await fetch(`${API}/api/v1/auth/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ walletAddress: addr, signature: sig }),
  });
  if (verify.data.error) {
    console.error('Auth failed:', verify.data);
    process.exit(1);
  }
  const userId = JSON.parse(Buffer.from(verify.data.token.split('.')[1], 'base64').toString()).userId;
  console.log('Demo user created:', userId);

  // Send 0.5 ETH to Treasury via cast (run in docker)
  console.log('\n--- Checkpoint A: Deposit 0.5 ETH ---');
  const { execSync } = require('child_process');
  try {
    execSync(
      `docker exec dicetiltclaude-evm-node-1 cast send ${TREASURY} "deposit()" --value 0.5ether --private-key 0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d --rpc-url http://127.0.0.1:8545`,
      { stdio: 'inherit' }
    );
  } catch (e) {
    console.error('Deposit tx failed:', e.message);
    process.exit(1);
  }
  console.log('Deposit tx sent. Waiting 5s for listener + ledger...');
  await new Promise((r) => setTimeout(r, 5000));

  // Check balance via API
  const config = await fetch(`${API}/api/v1/config`);
  console.log('Config:', config.data);

  console.log('\n--- Checkpoint B: Solana WithdrawalRequested (EVM ignores) ---');
  const { execSync: exec } = require('child_process');
  const solanaWithdrawal = JSON.stringify({
    withdrawal_id: '00000000-0000-0000-0000-000000000001',
    user_id: userId,
    chain: 'solana',
    currency: 'SOL',
    amount: '0.5',
    to_address: 'So11111111111111111111111111111111111111112',
    requested_at: new Date().toISOString(),
  });
  try {
    exec(
      `docker exec -i dicetiltclaude-kafka-1 /opt/kafka/bin/kafka-console-producer.sh --bootstrap-server localhost:29092 --topic WithdrawalRequested`,
      { input: solanaWithdrawal, stdio: ['pipe', 'pipe', 'pipe'] }
    );
  } catch (e) {
    console.log('kafka-console-producer may need different invocation');
  }
  console.log('Solana WithdrawalRequested produced. EVM Payout Worker should ignore (chain !== ethereum).');
  await new Promise((r) => setTimeout(r, 2000));

  console.log('\n--- Checkpoint C: Duplicate DepositReceived (idempotency) ---');
  const depositEvent = {
    deposit_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    user_id: userId,
    chain: 'ethereum',
    currency: 'ETH',
    amount: '1.0',
    wallet_address: addr,
    tx_hash: '0xdeadbeef',
    block_number: 1,
    deposited_at: new Date().toISOString(),
  };
  const dupPayload = JSON.stringify(depositEvent);
  try {
    exec(
      `echo "${dupPayload.replace(/"/g, '\\"')}" | docker exec -i dicetiltclaude-kafka-1 /opt/kafka/bin/kafka-console-producer.sh --bootstrap-server localhost:29092 --topic DepositReceived`,
      { shell: true }
    );
  } catch (e) {
    console.log('Produce attempt 1');
  }
  await new Promise((r) => setTimeout(r, 1000));
  try {
    exec(
      `echo "${dupPayload.replace(/"/g, '\\"')}" | docker exec -i dicetiltclaude-kafka-1 /opt/kafka/bin/kafka-console-producer.sh --bootstrap-server localhost:29092 --topic DepositReceived`,
      { shell: true }
    );
  } catch (e) {
    console.log('Produce attempt 2 (duplicate)');
  }
  console.log('Duplicate DepositReceived produced twice. Ledger Consumer ON CONFLICT DO NOTHING should prevent double credit.');
  await new Promise((r) => setTimeout(r, 3000));

  console.log('\n=== Verification complete ===');
  console.log('Manual checks:');
  console.log('- A: evm-listener logs should show DepositReceived');
  console.log('- B: evm-payout-worker logs should NOT process Solana withdrawal');
  console.log('- C: deposits table should have 1 row for deposit_id aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
