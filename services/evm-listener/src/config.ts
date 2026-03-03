import { readFileSync, existsSync } from 'node:fs';

function getTreasuryAddress(): string {
  const env = process.env.TREASURY_CONTRACT_ADDRESS;
  if (env) return env;
  const path = '/shared/treasury-addr';
  if (existsSync(path)) {
    return readFileSync(path, 'utf8').trim();
  }
  return '';
}

export const config = {
  evmRpcUrl: process.env.EVM_RPC_URL || 'http://127.0.0.1:8545',
  evmRpcWsUrl: process.env.EVM_RPC_WS_URL || 'ws://127.0.0.1:8545',
  treasuryAddress: getTreasuryAddress(),
  kafkaBrokers: (process.env.KAFKA_BROKERS || 'localhost:29092').split(','),
  dbUrl: process.env.DATABASE_URL || 'postgresql://dicetilt:dicetilt_dev_pass@localhost:5432/dicetilt',
  baseReconnectDelayMs: Number(process.env.EVM_LISTENER_BASE_DELAY_MS) || 1000,
  maxReconnectDelayMs: Number(process.env.EVM_LISTENER_MAX_DELAY_MS) || 30000,
};
