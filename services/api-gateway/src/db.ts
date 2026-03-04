import pg from 'pg';
import { config } from './config.js';

// Pool tuned for burst: explicit timeouts so pool.connect() fails fast instead of
// hanging when all slots are occupied. Sizes via config (DB_POOL_MAX / DB_POOL_MIN).
export const pool = new pg.Pool({
  connectionString: config.dbUrl,
  max: config.dbPoolMax,
  min: config.dbPoolMin,
  idleTimeoutMillis: config.dbIdleTimeoutMs,
  connectionTimeoutMillis: config.dbConnectionTimeoutMs,
});

export async function createUserWithWallets(
  userId: string,
  serverSeed: string,
  walletAddress: string,
): Promise<void> {
  // Fix #9 — normalize to lowercase at the DB layer as a defensive measure.
  // auth.routes.ts already normalizes, but a second call site could pass a
  // checksummed address; this guarantees consistent storage regardless.
  const normalizedAddress = walletAddress.toLowerCase();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      'INSERT INTO users (id, active_server_seed) VALUES ($1, $2)',
      [userId, serverSeed],
    );
    await client.query(
      `INSERT INTO wallets (user_id, chain, currency, balance, current_nonce, wallet_address)
       VALUES ($1, 'ethereum', 'ETH', $4, 0, $2),
              ($1, 'solana', 'SOL', $5, 0, $3)`,
      [userId, normalizedAddress, 'placeholder-solana-address', config.defaultEthBalance, config.defaultSolBalance],
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
  // Fix #9 — normalize at the DB layer so lookups succeed regardless of whether
  // the caller passes a checksummed (EIP-55) or already-lowercased address.
  const normalizedAddress = walletAddress.toLowerCase();
  // CTE separates the address→user_id lookup from the balance lookups, giving the
  // planner a cleaner two-phase access path instead of three self-joins on wallets.
  // Returns identical columns and values as the previous triple-join query.
  const r = await pool.query<{ user_id: string; active_server_seed: string; eth_balance: string; sol_balance: string }>(
    `WITH u AS (
       SELECT usr.id AS user_id, usr.active_server_seed
       FROM wallets w
       JOIN users usr ON usr.id = w.user_id
       WHERE w.wallet_address = $1 AND w.chain = 'ethereum'
       ORDER BY usr.created_at DESC
       LIMIT 1
     )
     SELECT u.user_id, u.active_server_seed,
            w_eth.balance::text AS eth_balance,
            w_sol.balance::text AS sol_balance
     FROM u
     LEFT JOIN wallets w_eth ON w_eth.user_id = u.user_id AND w_eth.chain = 'ethereum' AND w_eth.currency = 'ETH'
     LEFT JOIN wallets w_sol ON w_sol.user_id = u.user_id AND w_sol.chain = 'solana'   AND w_sol.currency = 'SOL'`,
    [normalizedAddress],
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

// H2/M9 — Append a new seed commitment to the immutable audit log.
// Called on user registration and every seed rotation (new seed side).
export async function insertSeedCommitment(
  userId: string,
  seedCommitment: string,
): Promise<void> {
  await pool.query(
    'INSERT INTO seed_commitment_audit (user_id, seed_commitment) VALUES ($1, $2)',
    [userId, seedCommitment],
  );
}

// H2/M9 — Reveal the seed for an existing commitment row.
// The WHERE clause ensures idempotency: only the first call fills the NULL columns.
export async function revealSeedInAudit(
  userId: string,
  seedCommitment: string,
  revealedSeed: string,
): Promise<void> {
  await pool.query(
    `UPDATE seed_commitment_audit
     SET revealed_seed = $1, revealed_at = NOW()
     WHERE user_id = $2 AND seed_commitment = $3 AND revealed_seed IS NULL`,
    [revealedSeed, userId, seedCommitment],
  );
}
