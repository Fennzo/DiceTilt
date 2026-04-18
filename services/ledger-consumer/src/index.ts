import pg from 'pg';
import Redis from 'ioredis';
import { Kafka } from 'kafkajs';
import { config } from './config.js';
import {
  KAFKA_TOPICS,
  type BetResolvedEvent,
  type DepositReceivedEvent,
  type WithdrawalCompletedEvent,
} from '@dicetilt/shared-types';
import { register, collectDefaultMetrics, Counter, Gauge } from 'prom-client';
import { createLoggers } from '@dicetilt/logger';

const { app: log, audit, security } = createLoggers('ledger-consumer');

collectDefaultMetrics();
const dlqTotal = new Counter({
  name: 'dicetilt_kafka_dlq_messages_total',
  help: 'Messages routed to DLQ',
  labelNames: ['source_topic'],
});
const kafkaLag = new Gauge({
  name: 'dicetilt_kafka_consumer_lag',
  help: 'Kafka consumer group lag (sum across partitions)',
  labelNames: ['topic'],
});
// C1 — Withdrawal Postgres UPDATE failed (e.g. balance CHECK tripped) while Redis
// was already deducted at request time. Real inconsistency that ops must reconcile.
// Alert on rate > 0.
const withdrawalPgInconsistency = new Counter({
  name: 'dicetilt_withdrawal_pg_inconsistency_total',
  help: 'Withdrawal Postgres write failed after Redis was debited — manual reconciliation required.',
});
// H5 — Deposit dual-write divergence: Redis balance does not match Postgres.
// Informational counter so ops can spot skew; individual occurrences are logged at security level.
const depositRedisPgSkew = new Counter({
  name: 'dicetilt_deposit_redis_pg_skew_total',
  help: 'Deposit processed but Redis balance diverges from Postgres — eventual-consistency gap.',
});

const pool = new pg.Pool({
  connectionString: config.dbUrl,
  max: config.dbPoolMax,
  idleTimeoutMillis: config.dbIdleTimeoutMs,
  connectionTimeoutMillis: config.dbConnectionTimeoutMs,
});
const redis = new Redis(config.redisUri, { maxRetriesPerRequest: config.redisMaxRetries });

// Atomically credit a deposit to Redis without overwriting accumulated bet P&L.
// If the key exists (normal case): INCRBYFLOAT adds the deposit amount on top.
// If the key is absent (Redis restart before re-auth): SET to the Postgres
// post-deposit balance so the account is still usable.
const DEPOSIT_CREDIT_LUA = `
local current = redis.call('GET', KEYS[1])
if current == false then
  redis.call('SET', KEYS[1], ARGV[2])
  return ARGV[2]
else
  return redis.call('INCRBYFLOAT', KEYS[1], ARGV[1])
end
`;

// ─── Batch INSERT helper for BetResolved ─────────────────────────────────────

// Cache the static placeholder string by row count so same-size batches never
// rebuild it. Key = number of rows; value = "$1,$2,...,$11),($12,...)" string.
const insertPlaceholderCache = new Map<number, string>();

function getBetInsertPlaceholders(count: number): string {
  const cached = insertPlaceholderCache.get(count);
  if (cached) return cached;
  const placeholders = Array.from({ length: count }, (_, i) => {
    const b = i * 11;
    return `($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6},$${b+7},$${b+8},$${b+9},$${b+10},$${b+11})`;
  }).join(',');
  insertPlaceholderCache.set(count, placeholders);
  return placeholders;
}

async function batchInsertBets(events: BetResolvedEvent[]): Promise<void> {
  if (events.length === 0) return;
  const client = await pool.connect();
  try {
    // Unnest bulk insert: one round-trip for N rows
    const placeholders = getBetInsertPlaceholders(events.length);
    const values = events.flatMap(ev => [
      ev.bet_id, ev.user_id, ev.chain, ev.currency,
      ev.wager_amount, ev.payout_amount, ev.game_result,
      ev.client_seed, ev.nonce_used, ev.outcome_hash, ev.executed_at,
    ]);
    const res = await client.query(
      `INSERT INTO transactions
         (bet_id, user_id, chain, currency, wager_amount, payout_amount, game_result, client_seed, nonce_used, outcome_hash, executed_at)
       VALUES ${placeholders}
       ON CONFLICT (bet_id) DO NOTHING`,
      values,
    );
    if (res.rowCount !== events.length) {
      // M4 — Audit skipped rows. rowCount < batch size means some rows were
      // skipped due to ON CONFLICT (bet_id) DO NOTHING.
      const skippedCount = events.length - (res.rowCount ?? 0);
      log.warn('Batch bet insert: some rows were skipped (idempotent duplicate)', {
        event: 'BATCH_INSERT_SKIPPED',
        batchSize: events.length,
        inserted: res.rowCount,
        skipped: skippedCount,
      });
    }
    for (const ev of events) {
      audit.info('Bet settled', {
        event: 'BET_SETTLED',
        betId: ev.bet_id,
        userId: ev.user_id,
        wager: ev.wager_amount,
        payout: ev.payout_amount,
        result: ev.game_result,
        chain: ev.chain,
        currency: ev.currency,
      });
    }
  } finally {
    client.release();
  }
}

// ─── Single-event handlers (for DepositReceived, WithdrawalCompleted) ─────────

async function processDepositReceived(ev: DepositReceivedEvent): Promise<boolean> {
  const client = await pool.connect();
  try {
    const r = await client.query<{ new_balance: string }>(
      `WITH ins AS (
         INSERT INTO deposits (deposit_id, user_id, chain, currency, amount, wallet_address, tx_hash, block_number, deposited_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (tx_hash) DO NOTHING
         RETURNING deposit_id
       )
       UPDATE wallets w
       SET balance = balance + $5::numeric
       FROM ins
       WHERE w.user_id = $2 AND w.chain = $3 AND w.currency = $4
       RETURNING w.balance::text AS new_balance`,
      [
        ev.deposit_id, ev.user_id, ev.chain, ev.currency, ev.amount,
        ev.wallet_address, ev.tx_hash, ev.block_number, ev.deposited_at,
      ],
    );
    if (r.rowCount === 0) return true; // idempotent duplicate

    // Postgres balance is the authority for deposits/withdrawals but does NOT track bets.
    // redis.set() would overwrite accumulated bet P&L; use Lua INCRBYFLOAT instead to
    // atomically add only the deposit amount on top of the current Redis balance.
    // Falls back to Postgres value only when the key is absent (e.g. after Redis restart).
    const pgNewBalance = r.rows[0].new_balance;
    const balanceKey = `user:${ev.user_id}:balance:${ev.chain}:${ev.currency}`;
    const redisNewBalance = (await redis.eval(
      DEPOSIT_CREDIT_LUA, 1, balanceKey, ev.amount, pgNewBalance,
    )) as string;

    // H5 — Dual-write skew detection. Redis tracks bet P&L and deposits; Postgres
    // tracks deposits/withdrawals only. After a deposit, Redis must be >= Postgres
    // (Redis includes net bet winnings on top). If Redis < Postgres, something
    // dropped writes (e.g. partial Lua exec, failover). Log + counter for ops.
    const redisBal = parseFloat(redisNewBalance);
    const pgBal = parseFloat(pgNewBalance);
    if (Number.isFinite(redisBal) && Number.isFinite(pgBal) && redisBal + 1e-9 < pgBal) {
      depositRedisPgSkew.inc();
      security.error('Deposit Redis/Postgres skew detected', {
        event: 'DEPOSIT_REDIS_PG_SKEW',
        depositId: ev.deposit_id,
        userId: ev.user_id,
        chain: ev.chain,
        currency: ev.currency,
        depositAmount: ev.amount,
        pgBalance: pgNewBalance,
        redisBalance: redisNewBalance,
        diff: (pgBal - redisBal).toString(),
      });
    }

    await redis.publish(`user:updates:${ev.user_id}`, JSON.stringify({
      type: 'BALANCE_UPDATE', chain: ev.chain, currency: ev.currency, balance: redisBal,
    }));

    audit.info('Deposit settled', {
      event: 'DEPOSIT_SETTLED',
      depositId: ev.deposit_id,
      userId: ev.user_id,
      amount: ev.amount,
      chain: ev.chain,
      currency: ev.currency,
      txHash: ev.tx_hash,
    });
    return true;
  } catch (err) {
    audit.error('Deposit settlement failed', {
      event: 'DEPOSIT_SETTLEMENT_FAILED',
      depositId: ev.deposit_id,
      error: String(err),
    });
    dlqTotal.inc({ source_topic: 'DepositReceived' });
    return false;
  } finally {
    client.release();
  }
}

async function processWithdrawalCompleted(ev: WithdrawalCompletedEvent): Promise<boolean> {
  const client = await pool.connect();
  try {
    // M5 — Use standard ON CONFLICT (tx_hash) DO NOTHING for idempotency.
    // Redis is intentionally NOT overwritten here — it was already atomically
    // deducted when the withdrawal was requested.
    const r = await client.query<{ withdrawal_id: string }>(
      `WITH ins AS (
         INSERT INTO withdrawals (withdrawal_id, user_id, chain, currency, amount, to_address, tx_hash, completed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (tx_hash) DO NOTHING
         RETURNING withdrawal_id
       )
       UPDATE wallets w
       SET balance = balance - $5::numeric
       FROM ins
       WHERE w.user_id = $2 AND w.chain = $3 AND w.currency = $4
       RETURNING ins.withdrawal_id`,
      [
        ev.withdrawal_id, ev.user_id, ev.chain, ev.currency, ev.amount,
        ev.to_address, ev.tx_hash, ev.completed_at,
      ],
    );
    if (r.rowCount === 0) return true; // idempotent duplicate

    // Redis balance was already atomically deducted at withdrawal-request time.
    // Publish BALANCE_UPDATE so any connected WS client that missed the immediate
    // fetchBalances() (e.g. page opened mid-flight) still gets a fresh balance signal.
    const balanceKey = `user:${ev.user_id}:balance:${ev.chain}:${ev.currency}`;
    const currentBalance = await redis.get(balanceKey);
    if (currentBalance !== null) {
      await redis.publish(`user:updates:${ev.user_id}`, JSON.stringify({
        type: 'BALANCE_UPDATE', chain: ev.chain, currency: ev.currency,
        balance: parseFloat(currentBalance),
      }));
    }

    await redis.publish(`user:updates:${ev.user_id}`, JSON.stringify({
      type: 'WITHDRAWAL_COMPLETED',
      withdrawalId: ev.withdrawal_id, chain: ev.chain,
      currency: ev.currency, txHash: ev.tx_hash, amount: ev.amount,
    }));

    audit.info('Withdrawal recorded', {
      event: 'WITHDRAWAL_RECORDED',
      withdrawalId: ev.withdrawal_id,
      userId: ev.user_id,
      amount: ev.amount,
      chain: ev.chain,
      currency: ev.currency,
      txHash: ev.tx_hash,
    });
    return true;
  } catch (err) {
    // C1 — Redis was already debited at withdraw-request time; if the Postgres
    // UPDATE fails (e.g. chk_wallets_balance_non_negative tripped by a replay),
    // the two stores are out of sync. Escalate to security.error with full context
    // so ops can reconcile, and track via an explicit counter (not just DLQ).
    withdrawalPgInconsistency.inc();
    security.error('Withdrawal Postgres inconsistency — Redis already debited', {
      event: 'WITHDRAWAL_PG_INCONSISTENCY',
      withdrawalId: ev.withdrawal_id,
      userId: ev.user_id,
      chain: ev.chain,
      currency: ev.currency,
      amount: ev.amount,
      txHash: ev.tx_hash,
      error: String(err),
    });
    audit.error('Withdrawal settlement failed', {
      event: 'WITHDRAWAL_SETTLEMENT_FAILED',
      withdrawalId: ev.withdrawal_id,
      error: String(err),
    });
    dlqTotal.inc({ source_topic: 'WithdrawalCompleted' });
    return false;
  } finally {
    client.release();
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const { kafkaSessionTimeoutMs, kafkaHeartbeatIntervalMs } = config;
  if (kafkaHeartbeatIntervalMs >= kafkaSessionTimeoutMs / 3) {
    throw new Error(
      `Kafka config invalid: heartbeatInterval (${kafkaHeartbeatIntervalMs}ms) must be < sessionTimeout/3 (${kafkaSessionTimeoutMs / 3}ms). ` +
        `Got sessionTimeout=${kafkaSessionTimeoutMs}ms, heartbeatInterval=${kafkaHeartbeatIntervalMs}ms.`,
    );
  }

  const kafka = new Kafka({ clientId: 'ledger-consumer', brokers: config.kafkaBrokers });
  const consumer = kafka.consumer({
    groupId: config.kafkaGroupId,
    // sessionTimeout must exceed worst-case batch DB write time to avoid spurious
    // rebalances. heartbeatInterval must be < sessionTimeout/3 (Kafka requirement).
    sessionTimeout: kafkaSessionTimeoutMs,
    heartbeatInterval: kafkaHeartbeatIntervalMs,
  });
  const admin = kafka.admin();

  await consumer.connect();
  await admin.connect();
  log.info('Kafka consumer connected', { event: 'KAFKA_CONSUMER_CONNECTED', groupId: config.kafkaGroupId });

  const subscribedTopics = [
    KAFKA_TOPICS.BET_RESOLVED,
    KAFKA_TOPICS.DEPOSIT_RECEIVED,
    KAFKA_TOPICS.WITHDRAWAL_COMPLETED,
  ];

  await consumer.subscribe({ topics: subscribedTopics, fromBeginning: false });

  const lagInterval = setInterval(async () => {
    try {
      for (const topic of subscribedTopics) {
        const [topicOffsets, committed] = await Promise.all([
          admin.fetchTopicOffsets(topic),
          admin.fetchOffsets({ groupId: config.kafkaGroupId, topics: [topic] }),
        ]);
        const committedMap = new Map<number, number>();
        for (const item of committed) {
          for (const p of item.partitions) {
            committedMap.set(p.partition, parseInt(p.offset, 10));
          }
        }
        let lag = 0;
        for (const po of topicOffsets) {
          const latest = parseInt(po.offset, 10);
          const committed = committedMap.get(po.partition) ?? 0;
          lag += Math.max(0, latest - committed);
        }
        kafkaLag.set({ topic }, lag);
      }
    } catch {
      // Non-fatal: admin polling failure doesn't stop consumer
    }
  }, config.kafkaLagPollIntervalMs);

  // H4 — At-least-once delivery. autoCommit:false + manual resolveOffset only
  // after a successful DB write guarantees a crash between "consume" and "persist"
  // re-delivers the message on restart. All DB writes are idempotent
  // (ON CONFLICT DO NOTHING / NOT EXISTS) so re-delivery is safe.
  await consumer.run({
    autoCommit: false,
    eachBatch: async ({ batch, heartbeat, resolveOffset, commitOffsetsIfNecessary, isRunning, isStale }) => {
      const { topic, messages } = batch;

      if (topic === KAFKA_TOPICS.BET_RESOLVED) {
        const BATCH_SIZE = config.betBatchSize;
        let i = 0;
        while (i < messages.length) {
          if (!isRunning() || isStale()) break;
          const end = Math.min(i + BATCH_SIZE, messages.length);
          const events: BetResolvedEvent[] = [];
          for (let j = i; j < end; j++) {
            const raw = messages[j]!.value?.toString();
            if (raw) {
              try { events.push(JSON.parse(raw) as BetResolvedEvent); } catch { /* skip malformed */ }
            }
          }
          if (events.length > 0) {
            try {
              await batchInsertBets(events);
              // Resolve offsets for the slice only after the batch INSERT succeeds.
              for (let j = i; j < end; j++) {
                resolveOffset(messages[j]!.offset);
              }
            } catch (err) {
              const batchBetIds = events.slice(0, 10).map((e) => e.bet_id);
              log.error('Batch BetResolved error', {
                event: 'BET_SETTLEMENT_FAILED',
                batchSize: events.length,
                messageRange: `${i}-${end}`,
                batchBetIds,
                ...(events.length > 10 && { batchTruncated: events.length - 10 }),
                error: String(err),
              });
              dlqTotal.inc({ source_topic: 'BetResolved' });
              // Do NOT resolve offsets on failure — Kafka will re-deliver after
              // the session times out, giving the retry a chance to succeed.
              break;
            }
          } else {
            // No parseable events in the slice — advance offsets to avoid a
            // poison-pill loop on permanently malformed frames.
            for (let j = i; j < end; j++) {
              resolveOffset(messages[j]!.offset);
            }
          }
          await commitOffsetsIfNecessary();
          await heartbeat();
          i = end;
        }
      } else {
        // Process deposit/withdrawal one at a time (rare events)
        for (const message of messages) {
          if (!isRunning() || isStale()) break;
          const raw = message.value?.toString();
          if (!raw) {
            resolveOffset(message.offset);
            continue;
          }
          try {
            let ok = true;
            if (topic === KAFKA_TOPICS.DEPOSIT_RECEIVED) {
              ok = await processDepositReceived(JSON.parse(raw) as DepositReceivedEvent);
            } else if (topic === KAFKA_TOPICS.WITHDRAWAL_COMPLETED) {
              ok = await processWithdrawalCompleted(JSON.parse(raw) as WithdrawalCompletedEvent);
            }
            // Resolve offset only on clean success. On ok=false (DB error already
            // logged + dlq-counted) leave offset unresolved so Kafka re-delivers.
            if (ok) resolveOffset(message.offset);
          } catch (err) {
            log.error('Kafka message parse error', { event: 'KAFKA_MESSAGE_PARSE_ERROR', topic, error: String(err) });
            dlqTotal.inc({ source_topic: topic });
            // Malformed JSON will never parse — advance offset to avoid a poison-pill
            // loop. The DLQ counter is the durable signal that ops must investigate.
            resolveOffset(message.offset);
          }
          await commitOffsetsIfNecessary();
          await heartbeat();
        }
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
      res.end(JSON.stringify({ status: 'healthy' }));
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  server.listen(config.metricsPort, () => log.info('Service started', { event: 'SERVICE_STARTED', port: config.metricsPort }));

  process.on('SIGTERM', async () => {
    clearInterval(lagInterval);
    await consumer.disconnect();
    await admin.disconnect();
    await pool.end();
    await redis.quit();
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
