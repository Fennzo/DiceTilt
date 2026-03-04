import Piscina from 'piscina';
import path from 'node:path';
import os from 'node:os';

// Worker file is at dist/worker.js at runtime (compiled TypeScript).
// __dirname = dist/ in CJS output, so this resolves to the correct path.
const workerFile = path.resolve(__dirname, 'worker.js');

// Pre-warm all threads at startup to eliminate cold-spawn latency on first
// request burst. minThreads = maxThreads means no lazy thread creation under load.
// PF_MIN_THREADS sets the floor (default 2); actual count = max(floor, cpuCount).
const parsedMinThreads = parseInt(process.env['PF_MIN_THREADS'] ?? '2', 10);
const minThreads = Number.isNaN(parsedMinThreads) || parsedMinThreads < 1 ? 2 : parsedMinThreads;
const threadCount = Math.max(minThreads, os.cpus().length);
export const pool = new Piscina({
  filename: workerFile,
  minThreads: threadCount,
  maxThreads: threadCount,
});
