import express from 'express';
import client from 'prom-client';
import { router } from './routes.js';
import { pool } from './pool.js';
import { createLoggers } from '@dicetilt/logger';

const { app: log } = createLoggers('provably-fair');

client.collectDefaultMetrics({ prefix: 'dicetilt_pf_' });

const app = express();
app.use(express.json());
app.use(router);

app.get('/metrics', async (_req, res) => {
  res.set('Content-Type', client.register.contentType);
  res.end(await client.register.metrics());
});

const PORT = parseInt(process.env['PF_PORT'] ?? '3001', 10);

const server = app.listen(PORT, () => {
  log.info('Service started', { event: 'SERVICE_STARTED', port: PORT });
});

function gracefulShutdown(signal: string) {
  log.info('Shutting down', { event: 'SERVICE_SHUTTING_DOWN', signal });
  server.close((err) => {
    if (err) {
      log.error('Server close error', { event: 'SHUTDOWN_ERROR', error: String(err) });
    }
    Promise.resolve(pool.destroy())
      .then(() => {
        process.exit(err ? 1 : 0);
      })
      .catch((destroyErr) => {
        log.error('Pool destroy error', { event: 'SHUTDOWN_ERROR', error: String(destroyErr) });
        process.exit(1);
      });
  });
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
