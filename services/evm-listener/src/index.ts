import { ethers } from 'ethers';
import { Kafka } from 'kafkajs';
import { v4 as uuidv4 } from 'uuid';
import { config } from './config.js';
import { getUserIdByWalletAddress, isTxHashAlreadyDeposited } from './db.js';
import { KAFKA_TOPICS, type DepositReceivedEvent } from '@dicetilt/shared-types';
import { register, collectDefaultMetrics, Counter } from 'prom-client';
import { createLoggers } from '@dicetilt/logger';

const { app: log, audit } = createLoggers('evm-listener');

collectDefaultMetrics();
const reconnectionsTotal = new Counter({
  name: 'dicetilt_web3_listener_reconnections_total',
  help: 'EVM listener reconnection count',
  labelNames: ['chain'],
});
const depositsTotal = new Counter({
  name: 'dicetilt_on_chain_deposits_total',
  help: 'On-chain deposits detected',
  labelNames: ['chain'],
});

const TREASURY_ABI = [
  'event Deposit(address indexed player, uint256 amount, uint256 timestamp)',
];

async function runListener() {
  if (!config.treasuryAddress) {
    log.error('TREASURY_CONTRACT_ADDRESS not set', { event: 'STARTUP_FAILED', error: 'CONFIG_MISSING' });
    process.exit(1);
  }

  const kafka = new Kafka({
    clientId: 'evm-listener',
    brokers: config.kafkaBrokers,
  });
  const producer = kafka.producer({ idempotent: true });
  await producer.connect();

  // Deduplication: in-memory Set bounded at MAX_DEDUP_CACHE entries.
  // Layer 2 (DB check) handles cross-restart dedup if an entry is evicted.
  const MAX_DEDUP_CACHE = config.dedupCacheSize;
  const seenTxHashes = new Set<string>();

  function trackTxHash(txHash: string): void {
    if (seenTxHashes.size >= MAX_DEDUP_CACHE) {
      const oldest = seenTxHashes.values().next().value as string;
      seenTxHashes.delete(oldest);
    }
    seenTxHashes.add(txHash);
  }

  // Extracted helper so live listener and historical scan share identical processing.
  async function processDeposit(
    txHash: string,
    player: string,
    amount: bigint,
    blockNumber: number,
  ): Promise<void> {
    // Layer 1: in-memory dedup (fast, same session)
    if (txHash && seenTxHashes.has(txHash)) {
      log.debug('Duplicate deposit ignored (memory)', { event: 'DEPOSIT_DUPLICATE_MEMORY', txHash });
      return;
    }
    // Layer 2: DB dedup (cross-restart protection)
    if (txHash && await isTxHashAlreadyDeposited(txHash)) {
      log.debug('Duplicate deposit ignored (db)', { event: 'DEPOSIT_DUPLICATE_DB', txHash });
      trackTxHash(txHash);
      return;
    }
    const userId = await getUserIdByWalletAddress(player, 'ethereum');
    if (!userId) {
      log.warn('No user for wallet address', { event: 'DEPOSIT_NO_USER', walletAddress: player, txHash });
      return;
    }

    const amountStr = ethers.formatEther(amount);
    const depositId = uuidv4();
    const event: DepositReceivedEvent = {
      deposit_id: depositId,
      user_id: userId,
      chain: 'ethereum',
      currency: 'ETH',
      amount: amountStr,
      wallet_address: player,
      tx_hash: txHash,
      block_number: blockNumber,
      deposited_at: new Date().toISOString(),
    };

    await producer.send({
      topic: KAFKA_TOPICS.DEPOSIT_RECEIVED,
      acks: -1,
      messages: [{ key: userId, value: JSON.stringify(event) }],
    });

    if (txHash) trackTxHash(txHash);

    depositsTotal.inc({ chain: 'ethereum' });
    audit.info('Deposit detected', {
      event: 'DEPOSIT_DETECTED',
      depositId,
      userId,
      walletAddress: player,
      amount: amountStr,
      txHash,
      blockNumber,
      chain: 'ethereum',
      currency: 'ETH',
    });
  }

  let provider: ethers.JsonRpcProvider | null = null;
  let attempt = 0;

  async function connect(): Promise<ethers.JsonRpcProvider> {
    // HTTP polling is used instead of WebSocket to avoid silent WS disconnections
    // (WebSocket connections to Anvil can die without emitting an error event after
    // several hours, causing the listener to silently miss all subsequent events).
    // JsonRpcProvider polls eth_getLogs every pollingIntervalMs — fully reliable.
    const p = new ethers.JsonRpcProvider(config.evmRpcUrl);
    p.pollingInterval = config.pollingIntervalMs;
    await p.getBlockNumber();
    return p;
  }

  async function listen() {
    try {
      provider = await connect();
      attempt = 0;
      log.info('Connected to EVM node', { event: 'EVM_CONNECTED', contractAddress: config.treasuryAddress });

      const contract = new ethers.Contract(
        config.treasuryAddress,
        TREASURY_ABI,
        provider,
      );

      // Historical scan: catches any Deposit events missed while the listener was down.
      // Runs once per connect(); dedup (in-memory Set + DB ON CONFLICT) prevents double-crediting.
      let scanHead = await provider.getBlockNumber();
      try {
        const pastEvents = await contract.queryFilter(contract.filters.Deposit(), 0, scanHead) as ethers.EventLog[];
        log.info('Historical scan complete', { event: 'HISTORICAL_SCAN', count: pastEvents.length });
        for (const ev of pastEvents) {
          try {
            await processDeposit(ev.transactionHash, ev.args[0] as string, ev.args[1] as bigint, ev.blockNumber);
          } catch (evErr) {
            log.error('Historical deposit error', { event: 'DEPOSIT_HANDLER_ERROR', txHash: ev.transactionHash, error: String(evErr) });
          }
        }
      } catch (scanErr) {
        log.warn('Historical scan failed (non-fatal)', { event: 'HISTORICAL_SCAN_ERROR', error: String(scanErr) });
      }

      // Block-based polling for new deposits — uses eth_getLogs (via queryFilter) on
      // each new block rather than eth_newFilter + eth_getFilterChanges.  Filters
      // expire on Anvil (and many RPC providers) after ~5 min of inactivity; block
      // polling has no such expiry and avoids the silent "filter not found" failure.
      // provider.on('block') polls eth_blockNumber every pollingIntervalMs — no filter.
      let blockProcessing = Promise.resolve();
      provider.on('block', (blockNumber: number) => {
        blockProcessing = blockProcessing.then(async () => {
          if (blockNumber <= scanHead) return;
          const from = scanHead + 1;
          const to   = blockNumber;
          scanHead   = blockNumber;
          try {
            const newEvents = await contract.queryFilter(contract.filters.Deposit(), from, to) as ethers.EventLog[];
            for (const ev of newEvents) {
              try {
                await processDeposit(ev.transactionHash, ev.args[0] as string, ev.args[1] as bigint, ev.blockNumber);
              } catch (evErr) {
                log.error('Block scan deposit error', { event: 'DEPOSIT_HANDLER_ERROR', txHash: ev.transactionHash, error: String(evErr) });
              }
            }
          } catch (err) {
            // Roll back scanHead so the range is retried on the next block.
            scanHead = from - 1;
            log.error('Block scan error', { event: 'DEPOSIT_HANDLER_ERROR', txHash: '', error: String(err) });
          }
        }).catch((err) => {
          log.error('Unhandled error in evm-listener block listener', { event: 'BLOCK_LISTENER_ERROR', error: String(err), stack: (err as Error).stack });
        });
      });

      provider.on('error', () => {
        reconnectionsTotal.inc({ chain: 'ethereum' });
        provider?.removeAllListeners();
        provider = null;
        scheduleReconnect();
      });
    } catch (err) {
      log.error('EVM connection error', { event: 'EVM_CONNECTION_ERROR', error: String(err) });
      reconnectionsTotal.inc({ chain: 'ethereum' });
      scheduleReconnect();
    }
  }

  function scheduleReconnect() {
    attempt++;
    const delay = Math.min(
      config.baseReconnectDelayMs * Math.pow(2, attempt),
      config.maxReconnectDelayMs,
    );
    log.warn('Reconnecting to EVM node', { event: 'EVM_RECONNECTING', attempt, delayMs: delay });
    setTimeout(listen, delay);
  }

  await listen();

  // Health + metrics
  const http = await import('node:http');
  const server = http.createServer(async (req, res) => {
    if (req.url === '/metrics') {
      res.setHeader('Content-Type', register.contentType);
      res.end(await register.metrics());
      return;
    }
    if (req.url === '/health') {
      const status = provider ? 'healthy' : 'degraded';
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ status, chain: 'ethereum' }));
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  server.listen(config.metricsPort, () => log.info('Service started', { event: 'SERVICE_STARTED', port: config.metricsPort }));

  process.on('SIGTERM', async () => {
    provider?.removeAllListeners();
    await producer.disconnect();
    await import('./db.js').then((m) => m.pool.end());
    process.exit(0);
  });
}

process.on('unhandledRejection', (reason) => {
  log.error('Unhandled rejection', { event: 'STARTUP_FAILED', error: String(reason) });
});

runListener().catch((e) => {
  log.error('Fatal startup error', { event: 'STARTUP_FAILED', error: String(e), stack: (e as Error).stack });
  process.exit(1);
});
