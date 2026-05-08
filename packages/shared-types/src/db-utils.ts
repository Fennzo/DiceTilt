import type pg from 'pg';

/**
 * Setup error handler for pg.Pool to prevent process crashes on idle client disconnections.
 * Without this handler, pg emits an 'error' event on idle clients disconnected by pgbouncer
 * (client_idle_timeout). If no listener is registered, Node.js crashes via the EventEmitter
 * default handler. pg.Pool reconnects automatically; we only need to log and stay alive.
 */
export function setupPoolErrorHandler(pool: pg.Pool, serviceName: string): void {
  pool.on('error', (err) => {
    console.error(`[${serviceName}] DB idle client error (pgbouncer likely closed connection):`, err.message);
  });
}
