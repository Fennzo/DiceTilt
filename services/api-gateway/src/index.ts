import http from 'node:http';
import express from 'express';
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

const app = express();
app.use(express.json());
app.use(authRouter);
app.use(pfRouter);
app.use(withdrawRouter);
if (config.testMode) {
  app.use(devRouter);
  console.log('[API Gateway] TEST_MODE enabled — /api/v1/dev/token active');
}
app.get('/metrics', metricsHandler as express.RequestHandler);

app.get('/api/v1/config', (_req, res) => {
  res.json({
    evmRpcUrl: config.publicEvmRpcUrl,
    treasuryContractAddress: config.treasuryContractAddress || null,
  });
});

async function start() {
  await connectProducer();
  console.log('[API Gateway] Kafka producer ready');

  const server = http.createServer(app);
  server.listen(config.port, () => {
    console.log(`[API Gateway] listening on :${config.port}`);
  });

  setupWebSocket(server);
  console.log('[API Gateway] WebSocket ready on /ws');

  async function gracefulShutdown(signal: string) {
    console.log(`[API Gateway] ${signal} received, shutting down...`);
    server.close();
    await disconnectProducer();
    await redis.quit();
    await redisSub.quit();
    await pool.end();
    console.log('[API Gateway] All connections closed');
    process.exit(0);
  }

  process.on('SIGTERM', () => { gracefulShutdown('SIGTERM'); });
  process.on('SIGINT', () => { gracefulShutdown('SIGINT'); });
}

start().catch((err) => {
  console.error('[API Gateway] Fatal startup error:', err);
  process.exit(1);
});
