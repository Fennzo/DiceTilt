import { readFileSync } from 'node:fs';
import { existsSync } from 'node:fs';

function getTreasuryAddress(): string {
  const env = process.env.TREASURY_CONTRACT_ADDRESS;
  if (env) return env;
  const path = '/shared/treasury-addr';
  if (existsSync(path)) return readFileSync(path, 'utf8').trim();
  return '';
}

export const config = {
  kafkaBrokers: (process.env.KAFKA_BROKERS || 'localhost:29092').split(','),
  evmRpcUrl: process.env.EVM_RPC_URL || 'http://127.0.0.1:8545',
  treasuryAddress: getTreasuryAddress(),
  privateKey: process.env.TREASURY_OWNER_PRIVATE_KEY || '',
};
