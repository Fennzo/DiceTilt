import express from 'express';
import client from 'prom-client';
import { router } from './routes.js';

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
  console.log(`[PF Worker] listening on :${PORT}`);
});

function gracefulShutdown(signal: string) {
  console.log(`[PF Worker] ${signal} received, shutting down...`);
  server.close(() => {
    console.log('[PF Worker] HTTP server closed');
    process.exit(0);
  });
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
