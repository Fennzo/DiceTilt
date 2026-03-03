import pg from 'pg';
import { config } from './config.js';

export const pool = new pg.Pool({ connectionString: config.dbUrl, max: 5 });

export async function isTxHashAlreadyDeposited(txHash: string): Promise<boolean> {
  const r = await pool.query<{ exists: boolean }>(
    'SELECT EXISTS(SELECT 1 FROM deposits WHERE tx_hash = $1) AS exists',
    [txHash],
  );
  return r.rows[0]?.exists === true;
}

export async function getUserIdByWalletAddress(
  walletAddress: string,
  chain: string,
): Promise<string | null> {
  const normalized = walletAddress.toLowerCase().startsWith('0x')
    ? walletAddress.toLowerCase()
    : walletAddress;
  // ORDER BY u.created_at DESC ensures we always pick the most recently created user —
  // matching the same selection logic used by auth.routes.ts (findUserByWalletAddress).
  // Without this, concurrent k6 load test runs can create duplicate users for the same
  // wallet address, and deposits get credited to the wrong (older) user.
  const r = await pool.query(
    `SELECT w.user_id FROM wallets w
     JOIN users u ON u.id = w.user_id
     WHERE LOWER(w.wallet_address) = $1 AND w.chain = $2
     ORDER BY u.created_at DESC
     LIMIT 1`,
    [normalized, chain],
  );
  return r.rows[0]?.user_id ?? null;
}
