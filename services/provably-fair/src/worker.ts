import { computeGameResult } from './crypto.service.js';

export interface WorkerInput {
  serverSeed: string;
  clientSeed: string;
  nonce: number;
}

// Piscina worker: offloads HMAC-SHA256 computation to a thread pool so the
// Express event loop is never blocked by CPU-bound hashing under load.
// TypeScript compiles this to CJS; piscina v4 detects __esModule=true and
// calls exports.default as the task function.
export default async function (input: WorkerInput): Promise<{ gameResult: number; gameHash: string }> {
  return computeGameResult(input.serverSeed, input.clientSeed, input.nonce);
}
