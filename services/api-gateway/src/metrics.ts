import client from 'prom-client';

client.collectDefaultMetrics({ prefix: 'dicetilt_' });

// Label cardinality: outcome={win,loss} × chain={ethereum,solana} × currency={ETH,SOL,USDC,USDT}
// Max time series: 2 × 2 × 4 = 16. Do NOT add unbounded label values (e.g. userId, betId).
export const betsTotal = new client.Counter({
  name: 'dicetilt_bets_total',
  help: 'Total bets placed',
  labelNames: ['outcome', 'chain', 'currency'] as const,
});

export const betProcessingDuration = new client.Histogram({
  name: 'dicetilt_bet_processing_duration_ms',
  help: 'Bet processing latency in milliseconds',
  buckets: [1, 5, 10, 20, 50, 100],
});

export const pfHashDuration = new client.Histogram({
  name: 'dicetilt_provably_fair_hash_duration_ms',
  help: 'PF Worker hash computation latency in milliseconds',
  buckets: [0.1, 0.5, 1, 2, 5],
});

export const redisLuaDuration = new client.Histogram({
  name: 'dicetilt_redis_lua_execution_duration_ms',
  help: 'Redis Lua script execution latency in milliseconds',
  buckets: [0.1, 0.5, 1, 2, 5],
});

export const activeWsConnections = new client.Gauge({
  name: 'dicetilt_active_websocket_connections',
  help: 'Current active WebSocket connections',
});

export const doubleSpendRejections = new client.Counter({
  name: 'dicetilt_double_spend_rejections_total',
  help: 'Balance check failures (insufficient funds)',
});

export const rateLimitRejections = new client.Counter({
  name: 'dicetilt_rate_limit_rejections_total',
  help: 'Rate limit rejections (user exceeded limit)',
  labelNames: ['limiter_type'] as const,
});

export const rateLimitRedisErrors = new client.Counter({
  name: 'dicetilt_rate_limit_redis_errors_total',
  help: 'Rate limit check failures due to Redis unavailability (infrastructure error, not user rejection).',
});

export const redisErrorRejections = new client.Counter({
  name: 'dicetilt_redis_error_rejections_total',
  help: 'Bet rejections due to Redis unavailability (fail closed). Alert on rate > 0.',
});

export const authFailures = new client.Counter({
  name: 'dicetilt_auth_failures_total',
  help: 'EIP-712 auth failures',
});

// Label cardinality: chain={ethereum,solana} × currency={ETH,SOL,USDC,USDT} = max 8 series.
export const wagerVolumeTotal = new client.Counter({
  name: 'dicetilt_wager_volume_total',
  help: 'Total volume wagered',
  labelNames: ['chain', 'currency'] as const,
});

export const withdrawalRequests = new client.Counter({
  name: 'dicetilt_withdrawal_requests_total',
  help: 'Withdrawal requests',
  labelNames: ['chain'] as const,
});

export const metricsHandler = async (_req: unknown, res: { set: (k: string, v: string) => void; end: (s: string) => void }) => {
  res.set('Content-Type', client.register.contentType);
  res.end(await client.register.metrics());
};
