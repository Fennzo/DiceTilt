import { ethers } from 'ethers';
import { Kafka } from 'kafkajs';
import { v4 as uuidv4 } from 'uuid';
import { config } from './config.js';
import { getUserIdByWalletAddress, isTxHashAlreadyDeposited } from './db.js';
import { KAFKA_TOPICS, type DepositReceivedEvent } from '@dicetilt/shared-types';
import { register, collectDefaultMetrics, Counter } from 'prom-client';

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
    console.error('[EVM Listener] TREASURY_CONTRACT_ADDRESS not set');
    process.exit(1);
  }

  const kafka = new Kafka({
    clientId: 'evm-listener',
    brokers: config.kafkaBrokers,
  });
  const producer = kafka.producer({ idempotent: true });
  await producer.connect();

  // Deduplication: ethers.js v6 can fire the same event multiple times per tx
  // (e.g. on WS reconnect or internal re-subscription). Track seen tx_hash values
  // so each on-chain deposit is only published to Kafka once.
  const seenTxHashes = new Set<string>();

  let provider: ethers.WebSocketProvider | ethers.JsonRpcProvider | null = null;
  let attempt = 0;

  async function connect(): Promise<ethers.WebSocketProvider | ethers.JsonRpcProvider> {
    const url = config.evmRpcWsUrl.startsWith('ws')
      ? config.evmRpcWsUrl
      : config.evmRpcUrl.replace(/^http/, 'ws');
    try {
      const p = new ethers.WebSocketProvider(url);
      await p.getBlockNumber();
      return p;
    } catch {
      const p = new ethers.JsonRpcProvider(config.evmRpcUrl);
      await p.getBlockNumber();
      return p;
    }
  }

  async function listen() {
    try {
      provider = await connect();
      attempt = 0;
      console.log('[EVM Listener] Connected to', config.evmRpcUrl);

      const contract = new ethers.Contract(
        config.treasuryAddress,
        TREASURY_ABI,
        provider,
      );

      contract.on('Deposit', async (player: string, amount: bigint, _timestamp: bigint, eventLog: unknown) => {
          try {
            // In ethers.js v6 the last callback arg is an EventLog object.
            // transactionHash and blockNumber are on its nested .log sub-property,
            // NOT at the top level (confirmed via runtime probe of the object keys).
            const evLog = eventLog as { log?: { transactionHash?: string; blockNumber?: number } };
            const txHash = evLog?.log?.transactionHash ?? '';

            // Layer 1: in-memory Set (fast, same session)
            if (txHash && seenTxHashes.has(txHash)) {
              console.log('[EVM Listener] Duplicate deposit ignored (memory)', txHash);
              return;
            }
            // Layer 2: DB check (cross-restart protection — Anvil replays historical
            // Deposit events on every new WS subscription)
            if (txHash && await isTxHashAlreadyDeposited(txHash)) {
              console.log('[EVM Listener] Duplicate deposit ignored (db)', txHash);
              seenTxHashes.add(txHash); // warm the cache
              return;
            }
            if (txHash) seenTxHashes.add(txHash);

            const userId = await getUserIdByWalletAddress(player, 'ethereum');
            if (!userId) {
              console.warn('[EVM Listener] No user for wallet', player);
              return;
            }

            const amountStr = ethers.formatEther(amount);
            const event: DepositReceivedEvent = {
              deposit_id: uuidv4(),
              user_id: userId,
              chain: 'ethereum',
              currency: 'ETH',
              amount: amountStr,
              wallet_address: player,
              tx_hash: txHash,
              block_number: evLog?.log?.blockNumber ?? 0,
              deposited_at: new Date().toISOString(),
            };

            await producer.send({
              topic: KAFKA_TOPICS.DEPOSIT_RECEIVED,
              acks: -1,
              messages: [{ key: userId, value: JSON.stringify(event) }],
            });

            depositsTotal.inc({ chain: 'ethereum' });
            console.log('[EVM Listener] DepositReceived', userId, amountStr, 'ETH');
          } catch (err) {
            console.error('[EVM Listener] Deposit handler error:', err);
          }
        },
      );

      provider.on('error', () => {
        reconnectionsTotal.inc({ chain: 'ethereum' });
        provider?.removeAllListeners();
        provider = null;
        scheduleReconnect();
      });
    } catch (err) {
      console.error('[EVM Listener] Connect error:', err);
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
    console.log(`[EVM Listener] Reconnecting in ${delay}ms (attempt ${attempt})`);
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
  server.listen(3010, () => console.log('[EVM Listener] Metrics :3010'));

  process.on('SIGTERM', async () => {
    provider?.removeAllListeners();
    await producer.disconnect();
    await import('./db.js').then((m) => m.pool.end());
    process.exit(0);
  });
}

runListener().catch((e) => {
  console.error(e);
  process.exit(1);
});
