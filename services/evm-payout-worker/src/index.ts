import { ethers } from 'ethers';
import { Kafka } from 'kafkajs';
import { config } from './config.js';
import { KAFKA_TOPICS, type WithdrawalRequestedEvent, type WithdrawalCompletedEvent } from '@dicetilt/shared-types';
import { register, collectDefaultMetrics, Counter } from 'prom-client';

collectDefaultMetrics();
const completionsTotal = new Counter({
  name: 'dicetilt_withdrawal_completions_total',
  help: 'Withdrawals completed on-chain',
  labelNames: ['chain'],
});

const TREASURY_ABI = [
  'function payout(address payable recipient, uint256 amount) external',
];

async function main() {
  if (!config.privateKey || !config.treasuryAddress) {
    console.error('[EVM Payout] TREASURY_OWNER_PRIVATE_KEY and TREASURY_CONTRACT_ADDRESS required');
    process.exit(1);
  }

  const provider = new ethers.JsonRpcProvider(config.evmRpcUrl);
  const wallet = new ethers.Wallet(config.privateKey, provider);
  const contract = new ethers.Contract(config.treasuryAddress, TREASURY_ABI, wallet);

  const kafka = new Kafka({
    clientId: 'evm-payout-worker',
    brokers: config.kafkaBrokers,
  });
  const consumer = kafka.consumer({ groupId: 'evm-payout-group' });
  const producer = kafka.producer({ idempotent: true });

  await consumer.connect();
  await producer.connect();

  await consumer.subscribe({ topic: KAFKA_TOPICS.WITHDRAWAL_REQUESTED, fromBeginning: false });

  // In-session dedup: skip replayed messages already paid in this run.
  const completedThisRun = new Set<string>();

  // Mutex: KafkaJS eachMessage can process different partitions concurrently.
  // This flag ensures only one payout tx is in-flight at any time so the wallet
  // nonce is consumed strictly in sequence.
  // Node.js is single-threaded: the while-check + assignment is atomic because
  // no await sits between them, so no two handlers can both pass the check.
  let payoutBusy = false;

  // Attempt to send a payout, retrying up to maxRetries times on NONCE_EXPIRED.
  // NONCE_EXPIRED means a ghost tx from a previous session (race condition era)
  // occupies that nonce. Retrying lets ethers query a fresh nonce and skip it.
  async function sendPayout(toAddress: string, amountWei: bigint, maxRetries = 20): Promise<string> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const tx = await contract.payout(toAddress, amountWei);
        const receipt = await tx.wait();
        return receipt?.hash ?? tx.hash;
      } catch (err: unknown) {
        lastErr = err;
        const code = (err as { code?: string })?.code;
        if (code === 'NONCE_EXPIRED' && attempt < maxRetries) {
          console.warn(`[EVM Payout] NONCE_EXPIRED on attempt ${attempt + 1} — retrying with fresh nonce`);
          continue;
        }
        throw err;
      }
    }
    throw lastErr;
  }

  await consumer.run({
    partitionsConsumedConcurrently: 1,
    eachMessage: async ({ topic, message }) => {
      const raw = message.value?.toString();
      if (!raw) return;
      const ev: WithdrawalRequestedEvent = JSON.parse(raw);
      if (ev.chain !== 'ethereum') return;

      // In-session idempotency: skip Kafka at-least-once redeliveries.
      if (completedThisRun.has(ev.withdrawal_id)) {
        console.log('[EVM Payout] Skip duplicate', ev.withdrawal_id);
        return;
      }

      // Acquire the payout mutex — spin until the previous send completes.
      // Prevents concurrent handlers on different partitions from racing for
      // the same wallet nonce.
      while (payoutBusy) {
        await new Promise<void>(resolve => setTimeout(resolve, 50));
      }
      payoutBusy = true;

      try {
        const amountWei = ethers.parseEther(ev.amount);
        const txHash = await sendPayout(ev.to_address, amountWei);

        const completed: WithdrawalCompletedEvent = {
          withdrawal_id: ev.withdrawal_id,
          user_id: ev.user_id,
          chain: 'ethereum',
          currency: ev.currency,
          amount: ev.amount,
          to_address: ev.to_address,
          tx_hash: txHash,
          completed_at: new Date().toISOString(),
        };

        await producer.send({
          topic: KAFKA_TOPICS.WITHDRAWAL_COMPLETED,
          acks: -1,
          messages: [{ key: ev.user_id, value: JSON.stringify(completed) }],
        });

        completedThisRun.add(ev.withdrawal_id);
        completionsTotal.inc({ chain: 'ethereum' });
        console.log('[EVM Payout] WithdrawalCompleted', ev.withdrawal_id, txHash);
      } catch (err: unknown) {
        console.error('[EVM Payout] Error processing', ev.withdrawal_id, ':', (err as Error).message ?? err);
      } finally {
        payoutBusy = false;
      }
    },
  });

  const http = await import('node:http');
  const server = http.createServer(async (req, res) => {
    if (req.url === '/metrics') {
      res.setHeader('Content-Type', register.contentType);
      res.end(await register.metrics());
      return;
    }
    if (req.url === '/health') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ status: 'healthy', chain: 'ethereum' }));
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  server.listen(3020, () => console.log('[EVM Payout] Metrics :3020'));

  process.on('SIGTERM', async () => {
    await consumer.disconnect();
    await producer.disconnect();
    process.exit(0);
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
