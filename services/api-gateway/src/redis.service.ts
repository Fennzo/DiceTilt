import Redis from 'ioredis';
import { config } from './config.js';

const DEDUCT_LUA = `
local balanceKey = KEYS[1]
local nonceKey = KEYS[2]
local wager = tonumber(ARGV[1])
local balance = tonumber(redis.call('GET', balanceKey) or '0')
if balance < wager then
  local nonce = tonumber(redis.call('GET', nonceKey) or '0')
  return {0, tostring(balance), tostring(nonce)}
end
local newBalance = balance - wager
redis.call('SET', balanceKey, tostring(newBalance))
local newNonce = redis.call('INCR', nonceKey)
return {1, tostring(newBalance), tostring(newNonce)}
`;

const CREDIT_LUA = `
local balanceKey = KEYS[1]
local payout = tonumber(ARGV[1])
local balance = tonumber(redis.call('GET', balanceKey) or '0')
local newBalance = balance + payout
redis.call('SET', balanceKey, tostring(newBalance))
return tostring(newBalance)
`;

export const redis = new Redis(config.redisUri, { maxRetriesPerRequest: 3 });
export const redisSub = new Redis(config.redisUri, { maxRetriesPerRequest: 3 });

export interface DeductResult {
  success: boolean;
  newBalance: string;
  nonce: number;
}

export async function atomicBalanceDeduct(
  userId: string,
  chain: string,
  currency: string,
  wagerAmount: string,
): Promise<DeductResult> {
  const balanceKey = `user:${userId}:balance:${chain}:${currency}`;
  const nonceKey = `user:${userId}:nonce:${chain}:${currency}`;

  const result = (await redis.eval(
    DEDUCT_LUA,
    2,
    balanceKey,
    nonceKey,
    wagerAmount,
  )) as [number, string, string];

  return {
    success: result[0] === 1,
    newBalance: result[1],
    nonce: parseInt(result[2], 10),
  };
}

export async function atomicBalanceCredit(
  userId: string,
  chain: string,
  currency: string,
  payoutAmount: string,
): Promise<string> {
  const balanceKey = `user:${userId}:balance:${chain}:${currency}`;
  return (await redis.eval(CREDIT_LUA, 1, balanceKey, payoutAmount)) as string;
}

export async function initUserRedisState(
  userId: string,
  serverSeed: string,
  ethBalance: string,
  solBalance: string,
): Promise<void> {
  const pipeline = redis.pipeline();
  pipeline.set(`user:${userId}:balance:ethereum:ETH`, ethBalance);
  pipeline.set(`user:${userId}:balance:solana:SOL`, solBalance);
  pipeline.set(`user:${userId}:nonce:ethereum:ETH`, '0');
  pipeline.set(`user:${userId}:nonce:solana:SOL`, '0');
  pipeline.set(`user:${userId}:serverSeed`, serverSeed);
  await pipeline.exec();
}

export async function setSession(userId: string, ttl: number = 86400): Promise<void> {
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
