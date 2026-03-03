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
  redisUri: process.env['REDIS_URI'] ?? 'redis://localhost:6379',
  kafkaBrokers: (process.env['KAFKA_BROKERS'] ?? 'localhost:29092').split(','),
  pfWorkerUrl: process.env['PF_WORKER_URL'] ?? 'http://localhost:3001',
  pfAuthToken: process.env['PF_AUTH_TOKEN'] ?? 'dicetilt-internal-pf-token',
  dbUrl: process.env['DATABASE_URL'] ?? 'postgresql://dicetilt:dicetilt_dev_pass@localhost:5432/dicetilt',
  defaultEthBalance: '10.00000000',
  defaultSolBalance: '10.00000000',
  // Public URLs accessible from the browser (not docker-internal hostnames)
  publicEvmRpcUrl: process.env['PUBLIC_EVM_RPC_URL'] ?? 'http://localhost:8545',
  treasuryContractAddress: getTreasuryContractAddress(),
  testMode: process.env['TEST_MODE'] === 'true',
} as const;
