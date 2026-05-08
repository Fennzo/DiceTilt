import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import Redis from 'ioredis';
import { config } from './config.js';
import { MS_PER_SECOND, REDIS_SCAN_BATCH_SIZE } from './constants.js';
import { createLoggers } from '@dicetilt/logger';

const { app: log } = createLoggers('api-gateway');

const moduleDir = __dirname;

function loadLuaScript(filename: string): string {
  const candidates = [
    // tsx/dev path (src/*.ts -> src/lua/*.lua)
    path.join(moduleDir, 'lua', filename),
    // tsc/prod path (dist/*.js -> src/lua/*.lua, if lua files are not copied to dist)
    path.join(moduleDir, '..', 'src', 'lua', filename),
  ];

  for (const scriptPath of candidates) {
    if (existsSync(scriptPath)) {
      return readFileSync(scriptPath, 'utf8');
    }
  }

  throw new Error(`Lua script not found: ${filename}`);
}

// Escrow model.
// On bet start:  deduct wager from balance_available, add to balance_escrowed (atomic).
// On bet settle: deduct wager from escrowed, credit payout to balance (both win and loss).
// On bet error:  release escrowed wager back to balance (replaces old creditWithRetry path).
//
// Key schema:
//   ws:conns:{userId}                          — global WS slot count (cluster + multi-instance)
//   user:{userId}:balance:{chain}:{currency}   — available balance
//   user:{userId}:escrowed:{chain}:{currency}  — in-play (bet wager held)
//   user:{userId}:nonce:{chain}:{currency}     — provably-fair nonce (unchanged)

// ESCROW_BET_LUA — atomically deducts wager from balance into escrow and increments nonce.
// Returns: [success(0|1), newBalance, newEscrowed, newNonce]
const ESCROW_BET_LUA = loadLuaScript('escrow-bet.lua');

// SETTLE_BET_LUA — releases wager from escrow and credits payout to balance.
// payout = 0 on loss, full payout on win.
// Returns: [newBalance, newEscrowed]
const SETTLE_BET_LUA = loadLuaScript('settle-bet.lua');

// RELEASE_ESCROW_LUA — error path: moves escrowed wager back to available balance.
// Used when PF worker fails or Kafka produce fails after escrow was taken.
// Returns: [newBalance, newEscrowed]
const RELEASE_ESCROW_LUA = loadLuaScript('release-escrow.lua');

// WITHDRAW_DEDUCT_LUA — used by the withdrawal route only (not bets).
// Does NOT touch the nonce key — provably-fair nonces are bet-only.
// Returns: [success(0|1), newBalance]
const WITHDRAW_DEDUCT_LUA = loadLuaScript('withdraw-deduct.lua');

// INIT_USER_SAFE_LUA — sets balance, nonce, serverSeed; only zeros escrow when already zero.
// Avoids racing with in-flight bets: if escrow is non-zero, leave it for settle/release to handle.
// KEYS[1..7]: balance_eth, balance_sol, escrow_eth, escrow_sol, nonce_eth, nonce_sol, server_seed
// ARGV[1..3]: eth_balance, sol_balance, server_seed
const INIT_USER_SAFE_LUA = loadLuaScript('init-user-safe.lua');

// WITHDRAW_CREDIT_LUA — credits balance back on withdrawal Kafka error.
const WITHDRAW_CREDIT_LUA = loadLuaScript('withdraw-credit.lua');

export const redis = new Redis(config.redisUri, { maxRetriesPerRequest: config.redisMaxRetries });
// enableReadyCheck: false prevents ioredis from running INFO on the subscriber
// connection after it enters subscriber mode (which would fail with "subscriber
// mode only" and corrupt the subscription state on reconnect).
export const redisSub = new Redis(config.redisUri, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

// Defence-in-depth: allowlist for chain and currency.
// Prevents an attacker from manipulating Redis key structure via raw API calls.
const ALLOWED_CHAINS = ['ethereum', 'solana'];
const ALLOWED_CURRENCIES = ['ETH', 'SOL', 'USDC', 'USDT'];

function validateParams(chain: string, currency: string): void {
  if (!ALLOWED_CHAINS.includes(chain) || !ALLOWED_CURRENCIES.includes(currency)) {
    throw new Error(`INVALID_PARAMS: chain=${chain}, currency=${currency}`);
  }
}

// Without these handlers, ioredis emits an 'error' event that — if no listener is
// registered — crashes the Node.js process via the EventEmitter default behaviour.
// ioredis handles reconnection internally; we only need to log and stay alive.
redis.on('error', (err) => log.error('Redis connection error', { event: 'REDIS_ERROR', error: String(err) }));
redisSub.on('error', (err) => log.error('Redis sub connection error', { event: 'REDIS_SUB_ERROR', error: String(err) }));

export interface EscrowResult {
  success: boolean;
  newBalance: string;   // available balance after escrow deduction
  newEscrowed: string;  // escrowed balance after adding wager
  nonce: number;
}

// Atomically deducts wager from available balance into escrow, increments nonce.
export async function atomicEscrowBet(
  userId: string,
  chain: string,
  currency: string,
  wagerAmount: string,
): Promise<EscrowResult> {
  validateParams(chain, currency);
  const balanceKey = `user:${userId}:balance:${chain}:${currency}`;
  const escrowKey  = `user:${userId}:escrowed:${chain}:${currency}`;
  const nonceKey   = `user:${userId}:nonce:${chain}:${currency}`;

  const result = (await redis.eval(
    ESCROW_BET_LUA, 3,
    balanceKey, escrowKey, nonceKey,
    wagerAmount,
  )) as [number, string, string, string];

  return {
    success:     result[0] === 1,
    newBalance:  result[1],
    newEscrowed: result[2],
    nonce:       parseInt(result[3], 10),
  };
}

// Releases wager from escrow and credits payout (0 on loss) to available balance.
// Called for both wins and losses — every escrowed bet must be settled.
export async function atomicSettleBet(
  userId: string,
  chain: string,
  currency: string,
  wagerAmount: string,
  payoutAmount: string,
): Promise<void> {
  validateParams(chain, currency);
  const balanceKey = `user:${userId}:balance:${chain}:${currency}`;
  const escrowKey  = `user:${userId}:escrowed:${chain}:${currency}`;
  await redis.eval(SETTLE_BET_LUA, 2, balanceKey, escrowKey, wagerAmount, payoutAmount);
}

// Error path: moves escrowed wager back to available balance.
// Used when PF worker fails or Kafka produce fails after escrow was taken.
export async function atomicReleaseEscrow(
  userId: string,
  chain: string,
  currency: string,
  wagerAmount: string,
): Promise<void> {
  validateParams(chain, currency);
  const balanceKey = `user:${userId}:balance:${chain}:${currency}`;
  const escrowKey  = `user:${userId}:escrowed:${chain}:${currency}`;
  await redis.eval(RELEASE_ESCROW_LUA, 2, balanceKey, escrowKey, wagerAmount);
}

// Withdrawal-specific deduct/credit — does NOT touch nonce or escrow keys.
export interface WithdrawDeductResult {
  success: boolean;
  newBalance: string;
}

export async function atomicBalanceDeduct(
  userId: string,
  chain: string,
  currency: string,
  amount: string,
): Promise<WithdrawDeductResult> {
  validateParams(chain, currency);
  const balanceKey = `user:${userId}:balance:${chain}:${currency}`;
  const result = (await redis.eval(WITHDRAW_DEDUCT_LUA, 1, balanceKey, amount)) as [number, string];
  return { success: result[0] === 1, newBalance: result[1] };
}

export async function atomicBalanceCredit(
  userId: string,
  chain: string,
  currency: string,
  amount: string,
): Promise<string> {
  validateParams(chain, currency);
  const balanceKey = `user:${userId}:balance:${chain}:${currency}`;
  return (await redis.eval(WITHDRAW_CREDIT_LUA, 1, balanceKey, amount)) as string;
}

export async function getUserEscrowed(
  userId: string,
  chain: string,
  currency: string,
): Promise<string | null> {
  validateParams(chain, currency);
  return redis.get(`user:${userId}:escrowed:${chain}:${currency}`);
}

export async function initUserRedisState(
  userId: string,
  serverSeed: string,
  ethBalance: string,
  solBalance: string,
): Promise<void> {
  const balanceEth = `user:${userId}:balance:ethereum:ETH`;
  const balanceSol = `user:${userId}:balance:solana:SOL`;
  const escrowEth = `user:${userId}:escrowed:ethereum:ETH`;
  const escrowSol = `user:${userId}:escrowed:solana:SOL`;
  const nonceEth = `user:${userId}:nonce:ethereum:ETH`;
  const nonceSol = `user:${userId}:nonce:solana:SOL`;
  const serverSeedKey = `user:${userId}:serverSeed`;

  await redis.eval(
    INIT_USER_SAFE_LUA,
    7,
    balanceEth,
    balanceSol,
    escrowEth,
    escrowSol,
    nonceEth,
    nonceSol,
    serverSeedKey,
    ethBalance,
    solBalance,
    serverSeed,
  );
}

export async function setSession(userId: string, ttl: number = config.sessionTtlSec): Promise<void> {
  await redis.set(`session:${userId}`, 'active', 'EX', ttl);
}

export async function checkSession(userId: string): Promise<boolean> {
  const val = await redis.get(`session:${userId}`);
  return val === 'active';
}

export async function getServerSeed(userId: string): Promise<string | null> {
  return redis.get(`user:${userId}:serverSeed`);
}

export async function getUserBalance(
  userId: string,
  chain: string,
  currency: string,
): Promise<string | null> {
  validateParams(chain, currency);
  return redis.get(`user:${userId}:balance:${chain}:${currency}`);
}

export async function getUserNonce(
  userId: string,
  chain: string,
  currency: string,
): Promise<number> {
  validateParams(chain, currency);
  const val = await redis.get(`user:${userId}:nonce:${chain}:${currency}`);
  return val ? parseInt(val, 10) : 0;
}

// Fixed-window rate limiter using Redis INCR.
//
// Key schema: ratelimit:{subject}:{action}:{windowBucket}
// where windowBucket = floor(nowMs / windowMs).
// One key per subject/action/window keeps Redis work at O(1) per request.
// TTL is set to window+1s so expired buckets self-clean without SCAN.
const RATE_LIMIT_LUA = loadLuaScript('rate-limit.lua');

export async function checkRateLimit(
  userId: string,
  action: string,
  windowSeconds: number,
  limit: number,
): Promise<boolean> {
  const nowMs = Date.now();
  const windowMs = windowSeconds * MS_PER_SECOND;
  const bucket = Math.floor(nowMs / windowMs);
  const key = `ratelimit:${userId}:${action}:${bucket}`;
  const result = await redis.eval(RATE_LIMIT_LUA, 1, key, limit, windowMs + MS_PER_SECOND) as number;
  return result === 1;
}

// Global per-user WebSocket slot counter (shared across cluster workers and replicas).
// Reserve: INCR atomically; if count > limit, DECR and deny. Refresh EXPIRE on success.
const WS_CONN_RESERVE_LUA = loadLuaScript('ws-conn-reserve.lua');
const WS_CONN_RELEASE_LUA = loadLuaScript('ws-conn-release.lua');

/** Atomically take a WS connection slot for userId. Returns false if over limit. */
export async function reserveWsConnectionSlot(
  userId: string,
  limit: number,
  ttlSec: number,
): Promise<boolean> {
  const key = `ws:conns:${userId}`;
  const result = await redis.eval(WS_CONN_RESERVE_LUA, 1, key, limit, ttlSec) as number;
  return result === 1;
}

/** Release one WS slot; safe if key missing or zero. */
export async function releaseWsConnectionSlot(userId: string): Promise<void> {
  const key = `ws:conns:${userId}`;
  await redis.eval(WS_CONN_RELEASE_LUA, 1, key);
}

/**
 * Flush all stale ws:conns:* counters on startup.
 *
 * When Docker force-kills the api-gateway container, WS close events never fire,
 * so releaseWsConnectionSlot (DECR) never runs. The counter stays stale at the
 * max (5) and blocks reconnections for up to 24 hours (the TTL default).
 *
 * Since every ws:conns key is created by the reserve function during the current
 * gateway lifecycle, ALL of them are stale after a restart. Flushing is safe:
 * - No in-flight connections exist yet (container just started).
 * - Each new connection will re-INCR via reserveWsConnectionSlot.
 *
 * Uses SCAN (not KEYS) to avoid blocking Redis on large key spaces.
 */
export async function flushStaleWsConnCounters(): Promise<number> {
  let flushed = 0;
  const stream = redis.scanStream({ match: 'ws:conns:*', count: REDIS_SCAN_BATCH_SIZE });
  return new Promise((resolve, reject) => {
    stream.on('data', (keys: string[]) => {
      if (keys.length > 0) {
        flushed += keys.length;
        redis.del(...keys).catch((err) => {
          // Log but don't fail — stale counters self-expire via TTL anyway.
          log.error('Failed to DEL ws:conns keys', { event: 'REDIS_DEL_ERROR', error: String(err) });
        });
      }
    });
    stream.on('end', () => resolve(flushed));
    stream.on('error', (err: Error) => reject(err));
  });
}
