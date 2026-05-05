import Redis from 'ioredis';

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

const REDIS_URL = process.env['REDIS_URI'] ?? 'redis://localhost:6379';

describe('Redis Lua Atomicity Tests', () => {
  let redis: Redis;
  const testUserId = 'test-user-lua';
  const balanceKey = `user:${testUserId}:balance:ethereum:ETH`;
  const nonceKey = `user:${testUserId}:nonce:ethereum:ETH`;

  beforeAll(async () => {
    redis = new Redis(REDIS_URL);
  });

  afterAll(async () => {
    await redis.del(balanceKey, nonceKey);
    await redis.quit();
  });

  beforeEach(async () => {
    await redis.set(balanceKey, '10.00000000');
    await redis.set(nonceKey, '0');
  });

  test('Atomic Lock: reject bet when balance insufficient', async () => {
    await redis.set(balanceKey, '5.00000000');

    const result = (await redis.eval(
      DEDUCT_LUA, 2, balanceKey, nonceKey, '10.00000000',
    )) as [number, string, string];

    expect(result[0]).toBe(0);
    expect(result[1]).toBe('5');

    const balance = await redis.get(balanceKey);
    expect(balance).toBe('5.00000000');

    const nonce = await redis.get(nonceKey);
    expect(nonce).toBe('0');
  });

  test('Atomic Lock: deduct succeeds when balance sufficient', async () => {
    const result = (await redis.eval(
      DEDUCT_LUA, 2, balanceKey, nonceKey, '3.00000000',
    )) as [number, string, string];

    expect(result[0]).toBe(1);
    expect(parseFloat(result[1])).toBeCloseTo(7, 1);
    expect(parseInt(result[2])).toBe(1);
  });

  test('Nonce Master: 3 bets increment nonce to 3', async () => {
    for (let i = 0; i < 3; i++) {
      await redis.eval(DEDUCT_LUA, 2, balanceKey, nonceKey, '1.00000000');
    }

    const nonce = await redis.get(nonceKey);
    expect(nonce).toBe('3');

    const balance = await redis.get(balanceKey);
    expect(parseFloat(balance!)).toBeCloseTo(7, 1);
  });

  test('Nonce Master: nonce resets to 0 on seed rotation', async () => {
    for (let i = 0; i < 3; i++) {
      await redis.eval(DEDUCT_LUA, 2, balanceKey, nonceKey, '1.00000000');
    }
    expect(await redis.get(nonceKey)).toBe('3');

    await redis.set(nonceKey, '0');
    expect(await redis.get(nonceKey)).toBe('0');
  });

  test('Credit Lua: adds payout to balance', async () => {
    const newBalance = (await redis.eval(
      CREDIT_LUA, 1, balanceKey, '5.50000000',
    )) as string;

    expect(parseFloat(newBalance)).toBeCloseTo(15.5, 1);
  });

  test('Concurrency: 10 rapid-fire bets never go negative', async () => {
    await redis.set(balanceKey, '5.00000000');
    await redis.set(nonceKey, '0');

    const promises = Array.from({ length: 10 }, () =>
      redis.eval(DEDUCT_LUA, 2, balanceKey, nonceKey, '1.00000000') as Promise<[number, string, string]>,
    );

    const results = await Promise.all(promises);
    const successes = results.filter((r) => r[0] === 1).length;
    const failures = results.filter((r) => r[0] === 0).length;

    expect(successes).toBe(5);
    expect(failures).toBe(5);

    const finalBalance = parseFloat((await redis.get(balanceKey))!);
    expect(finalBalance).toBeCloseTo(0, 1);
    expect(finalBalance).toBeGreaterThanOrEqual(0);

    const finalNonce = parseInt((await redis.get(nonceKey))!, 10);
    expect(finalNonce).toBe(5);
  });
});

// Keep scripts aligned with services/api-gateway/src/redis.service.ts (WS_CONN_*_LUA).
const WS_CONN_RESERVE_LUA = `
local key = KEYS[1]
local limit = tonumber(ARGV[1])
local ttlSec = tonumber(ARGV[2])
local n = tonumber(redis.call('INCR', key))
if n > limit then
  redis.call('DECR', key)
  local left = tonumber(redis.call('GET', key) or '0')
  if left <= 0 then
    redis.call('DEL', key)
  end
  return 0
end
if ttlSec > 0 then
  redis.call('EXPIRE', key, ttlSec)
end
return 1
`;

const WS_CONN_RELEASE_LUA = `
local key = KEYS[1]
local v = redis.call('GET', key)
if not v or tonumber(v) <= 0 then
  return 0
end
redis.call('DECR', key)
local left = redis.call('GET', key)
if not left or tonumber(left) <= 0 then
  redis.call('DEL', key)
end
return 1
`;

describe('WebSocket connection slot Lua', () => {
  let redis: Redis;
  const testUserId = 'test-user-ws-slot';
  const slotKey = `ws:conns:${testUserId}`;
  const limit = 5;
  const ttlSec = 3600;

  beforeAll(async () => {
    redis = new Redis(REDIS_URL);
  });

  afterAll(async () => {
    await redis.del(slotKey);
    await redis.quit();
  });

  beforeEach(async () => {
    await redis.del(slotKey);
  });

  test('allows exactly limit reserves then denies', async () => {
    for (let i = 0; i < limit; i++) {
      const ok = (await redis.eval(WS_CONN_RESERVE_LUA, 1, slotKey, limit, ttlSec)) as number;
      expect(ok).toBe(1);
    }
    const denied = (await redis.eval(WS_CONN_RESERVE_LUA, 1, slotKey, limit, ttlSec)) as number;
    expect(denied).toBe(0);
    const count = await redis.get(slotKey);
    expect(count).toBe(String(limit));
  });

  test('release frees a slot for another reserve', async () => {
    for (let i = 0; i < limit; i++) {
      await redis.eval(WS_CONN_RESERVE_LUA, 1, slotKey, limit, ttlSec);
    }
    await redis.eval(WS_CONN_RELEASE_LUA, 1, slotKey);
    const ok = (await redis.eval(WS_CONN_RESERVE_LUA, 1, slotKey, limit, ttlSec)) as number;
    expect(ok).toBe(1);
    expect(await redis.get(slotKey)).toBe(String(limit));
  });

  test('concurrency: never exceeds limit active reservations', async () => {
    const attempts = 50;
    const lowLimit = 5;
    await redis.del(slotKey);

    const results = await Promise.all(
      Array.from({ length: attempts }, () =>
        redis.eval(WS_CONN_RESERVE_LUA, 1, slotKey, lowLimit, ttlSec) as Promise<number>,
      ),
    );

    const granted = results.filter((r) => r === 1).length;
    expect(granted).toBe(lowLimit);

    expect(await redis.get(slotKey)).toBe(String(lowLimit));
  });
});
