import { readFileSync, existsSync } from 'node:fs';

function getTreasuryContractAddress(): string {
  const env = process.env['TREASURY_CONTRACT_ADDRESS'];
  if (env) return env;
  const path = '/shared/treasury-addr';
  if (existsSync(path)) return readFileSync(path, 'utf8').trim();
  return '';
}

export const config = {
  port: parseInt(process.env['API_PORT'] ?? '3000', 10),
  jwtSecret: process.env['JWT_SECRET'] ?? 'dev-secret',
  pseudonymSecret: process.env['PSEUDONYM_SECRET'] ?? 'dev-pseudonym-secret-not-for-production',
  pseudonymKeyVersion: process.env['PSEUDONYM_KEY_VERSION'] ?? '1',
  redisUri: process.env['REDIS_URI'] ?? 'redis://localhost:6379',
  kafkaBrokers: (process.env['KAFKA_BROKERS'] ?? 'localhost:29092').split(','),
  pfWorkerUrl: process.env['PF_WORKER_URL'] ?? 'http://localhost:3001',
  pfAuthToken: process.env['PF_AUTH_TOKEN'] ?? 'dicetilt-internal-pf-token',
  dbUrl: process.env['DATABASE_URL'] ?? 'postgresql://dicetilt:dicetilt_dev_pass@localhost:5432/dicetilt',
  defaultEthBalance: process.env['DEFAULT_ETH_BALANCE'] ?? '10.00000000',
  defaultSolBalance: process.env['DEFAULT_SOL_BALANCE'] ?? '10.00000000',
  // Internal EVM RPC URL (docker-internal, used by backend endpoints like faucet)
  evmRpcUrl: process.env['EVM_RPC_URL'] ?? 'http://localhost:8545',
  // Public URLs accessible from the browser (not docker-internal hostnames)
  publicEvmRpcUrl: process.env['PUBLIC_EVM_RPC_URL'] ?? 'http://localhost:8545',
  treasuryContractAddress: getTreasuryContractAddress(),
  testMode: process.env['TEST_MODE'] === 'true',

  // Challenge store (auth)
  maxChallengeStoreSize: parseInt(process.env['MAX_CHALLENGE_STORE_SIZE'] ?? '10000', 10),
  challengeTtlMs: parseInt(process.env['CHALLENGE_TTL_MS'] ?? '300000', 10),          // 5 minutes
  challengeCleanupIntervalMs: parseInt(process.env['CHALLENGE_CLEANUP_MS'] ?? '60000', 10),

  // Database pool
  dbPoolMax: parseInt(process.env['DB_POOL_MAX'] ?? '20', 10),
  dbPoolMin: parseInt(process.env['DB_POOL_MIN'] ?? '5', 10),
  dbIdleTimeoutMs: parseInt(process.env['DB_IDLE_TIMEOUT_MS'] ?? '30000', 10),
  dbConnectionTimeoutMs: parseInt(process.env['DB_CONN_TIMEOUT_MS'] ?? '5000', 10),

  // Redis
  redisMaxRetries: parseInt(process.env['REDIS_MAX_RETRIES'] ?? '3', 10),
  sessionTtlSec: parseInt(process.env['SESSION_TTL_SEC'] ?? '86400', 10),             // 24 hours

  // WebSocket
  wsAuthTimeoutMs: parseInt(process.env['WS_AUTH_TIMEOUT_MS'] ?? '10000', 10),
  wsMaxPayloadBytes: parseInt(process.env['WS_MAX_PAYLOAD_BYTES'] ?? '65536', 10),    // 64 KB
  maxWsConnectionsPerUser: parseInt(process.env['MAX_WS_CONNS_PER_USER'] ?? '5', 10),

  // Bet / game
  betRateLimitWindowSec: parseInt(process.env['BET_RATE_LIMIT_WINDOW_SEC'] ?? '1', 10),
  betRateLimitMax: parseInt(process.env['BET_RATE_LIMIT_MAX'] ?? '30', 10),
  houseEdgePct: parseFloat(process.env['HOUSE_EDGE_PCT'] ?? '1'),                    // 1% → payout = (100 - houseEdgePct) / winChance

  // Credit retry (win payout fire-and-forget)
  creditMaxAttempts: parseInt(process.env['CREDIT_MAX_ATTEMPTS'] ?? '3', 10),
  creditRetryBaseMs: parseInt(process.env['CREDIT_RETRY_BASE_MS'] ?? '100', 10),

  // Provably-fair worker
  pfTimeoutMs: parseInt(process.env['PF_TIMEOUT_MS'] ?? '5000', 10),

  // Cluster / process
  metricsPort: parseInt(process.env['METRICS_PORT'] ?? '9091', 10),
  shutdownTimeoutMs: parseInt(process.env['SHUTDOWN_TIMEOUT_MS'] ?? '5000', 10),
};

if (Number.isNaN(config.houseEdgePct) || config.houseEdgePct < 0 || config.houseEdgePct >= 100) {
  throw new Error(`Invalid HOUSE_EDGE_PCT: ${config.houseEdgePct} (must be in [0, 100))`);
}
