import crypto from 'node:crypto';
import Redis from 'ioredis';
import { config } from './config.js';

// C3/H6 — Escrow model.
// On bet start:  deduct wager from balance_available, add to balance_escrowed (atomic).
// On bet settle: deduct wager from escrowed, credit payout to balance (both win and loss).
// On bet error:  release escrowed wager back to balance (replaces old creditWithRetry path).
//
// Key schema:
//   user:{userId}:balance:{chain}:{currency}   — available balance
//   user:{userId}:escrowed:{chain}:{currency}  — in-play (bet wager held)
//   user:{userId}:nonce:{chain}:{currency}     — provably-fair nonce (unchanged)

// ESCROW_BET_LUA — atomically deducts wager from balance into escrow and increments nonce.
// Returns: [success(0|1), newBalance, newEscrowed, newNonce]
const ESCROW_BET_LUA = `
local balanceKey  = KEYS[1]
local escrowKey   = KEYS[2]
local nonceKey    = KEYS[3]
local wager       = tonumber(ARGV[1])
local balanceStr  = redis.call('GET', balanceKey) or '0'
local balance     = tonumber(balanceStr)
if balance < wager then
  local nonceStr  = redis.call('GET', nonceKey)  or '0'
  local escrowStr = redis.call('GET', escrowKey) or '0'
  return {0, balanceStr, escrowStr, nonceStr}
end
local newBalance  = balance - wager
redis.call('SET', balanceKey, tostring(newBalance))
local escrowed    = tonumber(redis.call('GET', escrowKey) or '0')
local newEscrowed = escrowed + wager
redis.call('SET', escrowKey, tostring(newEscrowed))
local newNonce = redis.call('INCR', nonceKey)
return {1, tostring(newBalance), tostring(newEscrowed), tostring(newNonce)}
`;

// SETTLE_BET_LUA — releases wager from escrow and credits payout to balance.
// payout = 0 on loss, full payout on win.
// Returns: [newBalance, newEscrowed]
const SETTLE_BET_LUA = `
local balanceKey  = KEYS[1]
local escrowKey   = KEYS[2]
local wager       = tonumber(ARGV[1])
local payout      = tonumber(ARGV[2])
local escrowed    = tonumber(redis.call('GET', escrowKey) or '0')
local newEscrowed = math.max(0, escrowed - wager)
redis.call('SET', escrowKey, tostring(newEscrowed))
local balance    = tonumber(redis.call('GET', balanceKey) or '0')
local newBalance = balance + payout
redis.call('SET', balanceKey, tostring(newBalance))
return {tostring(newBalance), tostring(newEscrowed)}
`;

// RELEASE_ESCROW_LUA — error path: moves escrowed wager back to available balance.
// Used when PF worker fails or Kafka produce fails after escrow was taken.
// Returns: [newBalance, newEscrowed]
const RELEASE_ESCROW_LUA = `
local balanceKey  = KEYS[1]
local escrowKey   = KEYS[2]
local wager       = tonumber(ARGV[1])
local escrowed    = tonumber(redis.call('GET', escrowKey) or '0')
local newEscrowed = math.max(0, escrowed - wager)
redis.call('SET', escrowKey, tostring(newEscrowed))
local balance    = tonumber(redis.call('GET', balanceKey) or '0')
local newBalance = balance + wager
redis.call('SET', balanceKey, tostring(newBalance))
return {tostring(newBalance), tostring(newEscrowed)}
`;

// WITHDRAW_DEDUCT_LUA — used by the withdrawal route only (not bets).
// Does NOT touch the nonce key — provably-fair nonces are bet-only.
// Returns: [success(0|1), newBalance]
const WITHDRAW_DEDUCT_LUA = `
local balanceKey = KEYS[1]
local amount     = tonumber(ARGV[1])
local balanceStr = redis.call('GET', balanceKey) or '0'
local balance    = tonumber(balanceStr)
if balance < amount then
  return {0, balanceStr}
end
local newBalance = balance - amount
redis.call('SET', balanceKey, tostring(newBalance))
return {1, tostring(newBalance)}
`;

// INIT_USER_SAFE_LUA — sets balance, nonce, serverSeed; only zeros escrow when already zero.
// Avoids racing with in-flight bets: if escrow is non-zero, leave it for settle/release to handle.
// KEYS[1..7]: balance_eth, balance_sol, escrow_eth, escrow_sol, nonce_eth, nonce_sol, server_seed
// ARGV[1..3]: eth_balance, sol_balance, server_seed
const INIT_USER_SAFE_LUA = `
local balanceEth  = KEYS[1]
local balanceSol  = KEYS[2]
local escrowEth   = KEYS[3]
local escrowSol   = KEYS[4]
local nonceEth    = KEYS[5]
local nonceSol    = KEYS[6]
local serverSeed  = KEYS[7]
local ethBal      = ARGV[1]
local solBal      = ARGV[2]
local seed        = ARGV[3]

redis.call('SET', balanceEth, ethBal)
redis.call('SET', balanceSol, solBal)

local eEth = tonumber(redis.call('GET', escrowEth) or '0') or 0
if eEth == 0 then
  redis.call('SET', escrowEth, '0')
end

local eSol = tonumber(redis.call('GET', escrowSol) or '0') or 0
if eSol == 0 then
  redis.call('SET', escrowSol, '0')
end

if eEth == 0 then
  redis.call('SET', nonceEth, '0')
end
if eSol == 0 then
  redis.call('SET', nonceSol, '0')
end
redis.call('SET', serverSeed, seed)
return 1
`;

// WITHDRAW_CREDIT_LUA — credits balance back on withdrawal Kafka error.
const WITHDRAW_CREDIT_LUA = `
local balanceKey = KEYS[1]
local amount     = tonumber(ARGV[1])
local balance    = tonumber(redis.call('GET', balanceKey) or '0')
local newBalance = balance + amount
redis.call('SET', balanceKey, tostring(newBalance))
return tostring(newBalance)
`;

export const redis = new Redis(config.redisUri, { maxRetriesPerRequest: config.redisMaxRetries });
// enableReadyCheck: false prevents ioredis from running INFO on the subscriber
// connection after it enters subscriber mode (which would fail with "subscriber
// mode only" and corrupt the subscription state on reconnect).
export const redisSub = new Redis(config.redisUri, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

// Without these handlers, ioredis emits an 'error' event that — if no listener is
// registered — crashes the Node.js process via the EventEmitter default behaviour.
// ioredis handles reconnection internally; we only need to log and stay alive.
redis.on('error', (err) => console.error('[Redis] Connection error:', err));
redisSub.on('error', (err) => console.error('[Redis] Sub connection error:', err));

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
  const balanceKey = `user:${userId}:balance:${chain}:${currency}`;
  return (await redis.eval(WITHDRAW_CREDIT_LUA, 1, balanceKey, amount)) as string;
}

export async function getUserEscrowed(
  userId: string,
  chain: string,
  currency: string,
): Promise<string | null> {
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
  return redis.get(`user:${userId}:balance:${chain}:${currency}`);
}

export async function getUserNonce(
  userId: string,
  chain: string,
  currency: string,
): Promise<number> {
  const val = await redis.get(`user:${userId}:nonce:${chain}:${currency}`);
  return val ? parseInt(val, 10) : 0;
}

// Sliding-window rate limiter using a Redis ZSET.
//
// Each call adds the current timestamp (ms) as score and a unique member
// (timestamp:requestId) to avoid ZADD collisions when multiple requests
// arrive in the same millisecond. Old entries outside the window are
// trimmed atomically. Returns 1 (allowed) or 0 (over limit).
//
// Key schema: ratelimit:{userId}:{action}
// TTL is set to window+1s so idle keys self-expire without a SCAN.
const RATE_LIMIT_LUA = `
local key      = KEYS[1]
local now      = tonumber(ARGV[1])
local window   = tonumber(ARGV[2])
local limit    = tonumber(ARGV[3])
local memberId = tostring(ARGV[4] or '')
local member   = tostring(now) .. ':' .. memberId
local windowMs = window * 1000
local cutoff   = now - windowMs

redis.call('ZREMRANGEBYSCORE', key, '-inf', cutoff)
local count = redis.call('ZCARD', key)
if count >= limit then
  return 0
end
redis.call('ZADD', key, now, member)
redis.call('PEXPIRE', key, windowMs + 1000)
return 1
`;

export async function checkRateLimit(
  userId: string,
  action: string,
  windowSeconds: number,
  limit: number,
): Promise<boolean> {
  const key = `ratelimit:${userId}:${action}`;
  const nowMs = Date.now();
  const requestId = crypto.randomUUID();
  const result = await redis.eval(RATE_LIMIT_LUA, 1, key, nowMs, windowSeconds, limit, requestId) as number;
  return result === 1;
}
