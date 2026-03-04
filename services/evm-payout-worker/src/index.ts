import { ethers } from 'ethers';
import { Kafka } from 'kafkajs';
import { config } from './config.js';
import { KAFKA_TOPICS, type WithdrawalRequestedEvent, type WithdrawalCompletedEvent } from '@dicetilt/shared-types';
import { register, collectDefaultMetrics, Counter } from 'prom-client';
import { createLoggers } from '@dicetilt/logger';

const { app: log, audit } = createLoggers('evm-payout-worker');

collectDefaultMetrics();
const completionsTotal = new Counter({
  name: 'dicetilt_withdrawal_completions_total',
  help: 'Withdrawals completed on-chain',
  labelNames: ['chain'],
});
const payoutFailuresTotal = new Counter({
  name: 'dicetilt_withdrawal_failures_total',
  help: 'Withdrawals that failed to execute on-chain after all retries',
  labelNames: ['chain'],
});

const TREASURY_ABI = [
  'function payout(address payable recipient, uint256 amount) external',
];

async function main() {
  if (!config.privateKey || !config.treasuryAddress) {
    log.error('Required config missing', { event: 'CONFIG_MISSING', missing: 'TREASURY_OWNER_PRIVATE_KEY or TREASURY_CONTRACT_ADDRESS' });
    process.exit(1);
  }

  const provider = new ethers.JsonRpcProvider(config.evmRpcUrl);
  const wallet = new ethers.Wallet(config.privateKey, provider);
  const contract = new ethers.Contract(config.treasuryAddress, TREASURY_ABI, wallet);

  const kafka = new Kafka({
    clientId: 'evm-payout-worker',
    brokers: config.kafkaBrokers,
  });
  const consumer = kafka.consumer({ groupId: config.kafkaGroupId });
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
  async function sendPayout(toAddress: string, amountWei: bigint, withdrawalId: string, maxRetries = config.payoutMaxRetries): Promise<string> {
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
          log.warn('NONCE_EXPIRED — retrying with fresh nonce', { event: 'NONCE_EXPIRED_RETRY', withdrawalId, attempt: attempt + 1, maxRetries });
          continue;
        }
        throw err;
      }
    }
    throw lastErr;
  }

  await consumer.run({
    partitionsConsumedConcurrently: 1,
    eachMessage: async ({ topic: _topic, message }) => {
      const raw = message.value?.toString();
      if (!raw) return;
      let ev: WithdrawalRequestedEvent;
      try {
        ev = JSON.parse(raw) as WithdrawalRequestedEvent;
      } catch {
        log.error('Malformed Kafka message — skipping', { event: 'PAYOUT_ERROR', withdrawalId: 'unknown', error: 'JSON parse failed' });
        return;
      }
      if (ev.chain !== 'ethereum') return;

      // In-session idempotency: skip Kafka at-least-once redeliveries.
      if (completedThisRun.has(ev.withdrawal_id)) {
        log.info('Skip duplicate withdrawal', { event: 'WITHDRAWAL_DUPLICATE_SESSION', withdrawalId: ev.withdrawal_id });
        return;
      }

      // Acquire the payout mutex — spin until the previous send completes.
      // Prevents concurrent handlers on different partitions from racing for
      // the same wallet nonce.
      while (payoutBusy) {
        await new Promise<void>(resolve => setTimeout(resolve, config.payoutMutexSpinMs));
      }
      payoutBusy = true;

      try {
        const amountWei = ethers.parseEther(ev.amount);
        const txHash = await sendPayout(ev.to_address, amountWei, ev.withdrawal_id);

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
        audit.info('Payout executed', {
          event: 'PAYOUT_EXECUTED',
          withdrawalId: ev.withdrawal_id,
          userId: ev.user_id,
          amount: ev.amount,
          chain: 'ethereum',
          currency: ev.currency,
          txHash,
          toAddress: ev.to_address,
        });
      } catch (err: unknown) {
        payoutFailuresTotal.inc({ chain: 'ethereum' });
        log.error('Payout error', {
          event: 'PAYOUT_ERROR',
          withdrawalId: ev.withdrawal_id,
          error: (err as Error).message ?? String(err),
          stack: (err as Error).stack,
        });
        // The Redis balance was pre-deducted at withdrawal-request time.
        // Manual recovery required: re-queue this withdrawal_id or credit back via admin.
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
  server.listen(config.metricsPort, () => log.info('Service started', { event: 'SERVICE_STARTED', port: config.metricsPort }));

  process.on('SIGTERM', async () => {
    await consumer.disconnect();
    await producer.disconnect();
    process.exit(0);
  });
}

process.on('unhandledRejection', (reason) => {
  log.error('Unhandled rejection', { event: 'STARTUP_FAILED', error: String(reason) });
  process.exit(1);
});

main().catch((e) => {
  log.error('Fatal startup error', { event: 'STARTUP_FAILED', error: String(e), stack: (e as Error).stack });
  process.exit(1);
});
