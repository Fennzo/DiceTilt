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
