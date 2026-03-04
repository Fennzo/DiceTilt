import cluster from 'node:cluster';
import os from 'node:os';
import http from 'node:http';
import express from 'express';
import { AggregatorRegistry } from 'prom-client';
import { authRouter } from './auth.routes.js';
import { pfRouter } from './pf.routes.js';
import { withdrawRouter } from './withdraw.routes.js';
import { devRouter } from './dev.routes.js';
import { setupWebSocket } from './ws.handler.js';
import { connectProducer, disconnectProducer } from './kafka.producer.js';
import { redis, redisSub } from './redis.service.js';
import { pool } from './db.js';
import { config } from './config.js';
import { metricsHandler } from './metrics.js';
import { createLoggers } from '@dicetilt/logger';

const { app: log } = createLoggers('api-gateway');

if (cluster.isPrimary) {
  // ── Primary process ────────────────────────────────────────────────────────
  // Forks N workers to saturate available CPU cores for I/O-bound connection
  // throughput. Serves aggregated Prometheus metrics on port 9091 via IPC so
  // all workers contribute to a single scrape target.
  const numWorkers =
    parseInt(process.env['CLUSTER_WORKERS'] ?? '0', 10) ||
    Math.max(2, os.cpus().length);

  log.info('Primary starting, forking workers', {
    event: 'SERVICE_STARTED',
    numWorkers,
    pid: process.pid,
  });

  let isShuttingDown = false;

  for (let i = 0; i < numWorkers; i++) {
    cluster.fork();
  }

  cluster.on('exit', (worker, code, signal) => {
    if (isShuttingDown) return;
    log.warn('Worker exited unexpectedly, respawning', {
      event: 'WORKER_EXITED',
      workerId: worker.id,
      code,
      signal,
    });
    cluster.fork();
  });

  // Aggregated metrics endpoint — single Prometheus scrape target.
  // AggregatorRegistry collects per-worker registries via IPC so no metric
  // data is lost or double-counted across the worker pool.
  const aggregatorRegistry = new AggregatorRegistry();
  const metricsServer = http.createServer(async (_req, res) => {
    try {
      const metrics = await aggregatorRegistry.clusterMetrics();
      res.setHeader('Content-Type', aggregatorRegistry.contentType);
      res.end(metrics);
    } catch (err) {
      res.statusCode = 500;
      res.end(String(err));
    }
  });
  metricsServer.listen(config.metricsPort, () => {
    log.info('Metrics aggregator listening', { event: 'SERVICE_STARTED', metricsPort: config.metricsPort });
  });

  const shutdown = () => {
    isShuttingDown = true;
    log.info('Primary shutting down workers', { event: 'SERVICE_SHUTTING_DOWN', signal: 'SIGTERM' });
    for (const worker of Object.values(cluster.workers ?? {})) {
      worker?.kill('SIGTERM');
    }
    // Force-exit after configured timeout in case a worker stalls during shutdown
    setTimeout(() => process.exit(0), config.shutdownTimeoutMs).unref();
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

} else {
  // ── Worker process ─────────────────────────────────────────────────────────
  if (config.testMode && process.env['NODE_ENV'] === 'production') {
    log.error('Misconfiguration: TEST_MODE=true with NODE_ENV=production — refusing to start', {
      event: 'CONFIG_ERROR',
      testMode: config.testMode,
      nodeEnv: process.env['NODE_ENV'],
    });
    process.exit(1);
  }
  // prom-client v15: AggregatorRegistry constructor calls addListeners(), which
  // registers the worker-side IPC handler that responds to clusterMetrics()
  // requests from the primary. Without this, workers silently never respond.
  new AggregatorRegistry(); // eslint-disable-line no-new
  const app = express();
  app.use(express.json());
  app.use(authRouter);
  app.use(pfRouter);
  app.use(withdrawRouter);
  if (config.testMode) {
    app.use(devRouter);
    log.info('TEST_MODE enabled — /api/v1/dev/token active', { event: 'SERVICE_STARTED', testMode: true });
  }
  // Per-worker metrics (individual worker view; aggregated view on primary:9091)
  app.get('/metrics', metricsHandler as express.RequestHandler);
  app.get('/api/v1/config', (_req, res) => {
    res.json({
      evmRpcUrl: config.publicEvmRpcUrl,
      treasuryContractAddress: config.treasuryContractAddress || null,
    });
  });

  async function start() {
    await connectProducer();

    const server = http.createServer(app);
    server.listen(config.port, () => {
      log.info('Worker started', {
        event: 'SERVICE_STARTED',
        port: config.port,
        workerId: cluster.worker?.id,
        pid: process.pid,
        testMode: config.testMode,
      });
    });

    setupWebSocket(server);

    let shuttingDown = false;
    const gracefulShutdown = async (signal: string) => {
      if (shuttingDown) return;
      shuttingDown = true;

      log.info('Worker shutting down', {
        event: 'SERVICE_SHUTTING_DOWN',
        signal,
        workerId: cluster.worker?.id,
      });

      try {
        try {
          await new Promise<void>((resolve, reject) => {
            server.close((err) => (err ? reject(err) : resolve()));
          });
        } catch (err) {
          log.error('Server close error', { event: 'SHUTDOWN_ERROR', error: String(err) });
        }

        try {
          await disconnectProducer();
        } catch (err) {
          log.error('Producer disconnect error', { event: 'SHUTDOWN_ERROR', error: String(err) });
        }

        try {
          await redis.quit();
        } catch (err) {
          log.error('Redis quit error', { event: 'SHUTDOWN_ERROR', error: String(err) });
        }

        try {
          await redisSub.quit();
        } catch (err) {
          log.error('Redis subscriber quit error', { event: 'SHUTDOWN_ERROR', error: String(err) });
        }

        try {
          await pool.end();
        } catch (err) {
          log.error('Pool end error', { event: 'SHUTDOWN_ERROR', error: String(err) });
        }
      } finally {
        process.exit(0);
      }
    };

    const onSignal = (signal: string) => {
      gracefulShutdown(signal).catch((err) => {
        log.error('Graceful shutdown failed', { event: 'SHUTDOWN_ERROR', error: String(err) });
      });
    };
    process.on('SIGTERM', () => onSignal('SIGTERM'));
    process.on('SIGINT', () => onSignal('SIGINT'));
  }

  process.on('unhandledRejection', (reason) => {
    log.error('Unhandled rejection', { event: 'STARTUP_FAILED', error: String(reason) });
  });

  start().catch((err) => {
    log.error('Fatal startup error', { event: 'STARTUP_FAILED', error: String(err), stack: (err as Error).stack });
    process.exit(1);
  });
}
