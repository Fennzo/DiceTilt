import pg from 'pg';
import { config } from './config.js';

export const pool = new pg.Pool({ connectionString: config.dbUrl, max: 10 });

export async function createUserWithWallets(
  userId: string,
  serverSeed: string,
  walletAddress: string,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      'INSERT INTO users (id, active_server_seed) VALUES ($1, $2)',
      [userId, serverSeed],
    );
    await client.query(
      `INSERT INTO wallets (user_id, chain, currency, balance, current_nonce, wallet_address)
       VALUES ($1, 'ethereum', 'ETH', 10.0, 0, $2),
              ($1, 'solana', 'SOL', 10.0, 0, $3)`,
      [userId, walletAddress, 'placeholder-solana-address'],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function getWalletAddress(
  userId: string,
  chain: string,
  currency: string,
): Promise<string | null> {
  const r = await pool.query(
    'SELECT wallet_address FROM wallets WHERE user_id = $1 AND chain = $2 AND currency = $3',
    [userId, chain, currency],
  );
  return r.rows[0]?.wallet_address ?? null;
}

export interface ExistingUser {
  userId: string;
  serverSeed: string;
  ethBalance: string;
  solBalance: string;
}

export async function findUserByWalletAddress(walletAddress: string): Promise<ExistingUser | null> {
  const r = await pool.query<{ user_id: string; active_server_seed: string; eth_balance: string; sol_balance: string }>(
    `SELECT u.id AS user_id, u.active_server_seed,
            COALESCE(w_eth.balance, 10)::text AS eth_balance,
            COALESCE(w_sol.balance, 10)::text AS sol_balance
     FROM wallets w
     JOIN users u ON u.id = w.user_id
     LEFT JOIN wallets w_eth ON w_eth.user_id = u.id AND w_eth.chain = 'ethereum' AND w_eth.currency = 'ETH'
     LEFT JOIN wallets w_sol ON w_sol.user_id = u.id AND w_sol.chain = 'solana'  AND w_sol.currency = 'SOL'
     WHERE w.wallet_address = $1 AND w.chain = 'ethereum'
     ORDER BY u.created_at DESC
     LIMIT 1`,
    [walletAddress],
  );
  if (!r.rows[0]) return null;
  const row = r.rows[0];
  return {
    userId: row.user_id,
    serverSeed: row.active_server_seed,
    ethBalance: row.eth_balance,
    solBalance: row.sol_balance,
  };
}

export async function updateServerSeed(
  userId: string,
  newSeed: string,
  previousSeed: string,
): Promise<void> {
  await pool.query(
    'UPDATE users SET active_server_seed = $1, previous_server_seed = $2 WHERE id = $3',
    [newSeed, previousSeed, userId],
  );
}
