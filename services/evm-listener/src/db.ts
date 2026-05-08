import pg from 'pg';
import { config } from './config.js';
import { setupPoolErrorHandler } from '@dicetilt/shared-types';

export const pool = new pg.Pool({ connectionString: config.dbUrl, max: 5 });

setupPoolErrorHandler(pool, 'evm-listener');

export async function isTxHashAlreadyDeposited(txHash: string): Promise<boolean> {
  const r = await pool.query<{ exists: boolean }>(
    'SELECT EXISTS(SELECT 1 FROM deposits WHERE tx_hash = $1) AS exists',
    [txHash],
  );
  return r.rows[0]?.exists === true;
}

export async function getMaxDepositedBlockNumber(): Promise<number | null> {
  const r = await pool.query<{ max_block: number | null }>(
    'SELECT MAX(block_number) AS max_block FROM deposits',
  );
  return r.rows[0]?.max_block ?? null;
}

/**
 * Recompute ethereum wallet balances from the current-chain deposits/withdrawals/bets.
 * Postgres wallets.balance is the canonical authority using the formula:
 *   balance = default + deposits - withdrawals - wagers + payouts
 */
export async function recomputeEthereumWalletBalances(defaultEthBalance: string): Promise<void> {
  await pool.query(
    `WITH deposit_totals AS (
       SELECT user_id, COALESCE(SUM(amount), 0) AS deposit_sum
       FROM deposits
       WHERE chain = 'ethereum' AND currency = 'ETH'
       GROUP BY user_id
     ),
     withdrawal_totals AS (
       SELECT user_id, COALESCE(SUM(amount), 0) AS withdrawal_sum
       FROM withdrawals
       WHERE chain = 'ethereum' AND currency = 'ETH'
       GROUP BY user_id
     ),
     bet_totals AS (
       SELECT user_id,
              COALESCE(SUM(wager_amount), 0) AS wager_sum,
              COALESCE(SUM(payout_amount), 0) AS payout_sum
       FROM transactions
       WHERE chain = 'ethereum' AND currency = 'ETH'
       GROUP BY user_id
     )
     UPDATE wallets w
     SET balance = GREATEST(0, $1::numeric
       + COALESCE(d.deposit_sum, 0)
       - COALESCE(x.withdrawal_sum, 0)
       - COALESCE(b.wager_sum, 0)
       + COALESCE(b.payout_sum, 0))
     FROM wallets base
     LEFT JOIN deposit_totals d ON d.user_id = base.user_id
     LEFT JOIN withdrawal_totals x ON x.user_id = base.user_id
     LEFT JOIN bet_totals b ON b.user_id = base.user_id
     WHERE w.id = base.id
       AND base.chain = 'ethereum'
       AND base.currency = 'ETH'`,
    [defaultEthBalance],
  );
}

/**
 * Purge stale chain data when an Anvil chain reset is detected.
 *
 * When the current chain head is lower than the highest block in the deposits
 * table, it means the chain was reset (docker restart). All ethereum deposits
 * and withdrawals from the old chain instance must be removed, then wallet
 * balances must be recomputed from the current-chain records using the
 * canonical formula: default + deposits - withdrawals - wagers + payouts.
 */
export async function purgeStaleChainData(defaultEthBalance: string): Promise<{ depositsPurged: number; withdrawalsPurged: number }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const depositDeletion = await client.query(
      "DELETE FROM deposits WHERE chain = 'ethereum'",
    );

    const withdrawalDeletion = await client.query(
      "DELETE FROM withdrawals WHERE chain = 'ethereum'",
    );

    await client.query(
      `WITH deposit_totals AS (
         SELECT user_id, COALESCE(SUM(amount), 0) AS deposit_sum
         FROM deposits
         WHERE chain = 'ethereum' AND currency = 'ETH'
         GROUP BY user_id
       ),
       withdrawal_totals AS (
         SELECT user_id, COALESCE(SUM(amount), 0) AS withdrawal_sum
         FROM withdrawals
         WHERE chain = 'ethereum' AND currency = 'ETH'
         GROUP BY user_id
       ),
       bet_totals AS (
         SELECT user_id,
                COALESCE(SUM(wager_amount), 0) AS wager_sum,
                COALESCE(SUM(payout_amount), 0) AS payout_sum
         FROM transactions
         WHERE chain = 'ethereum' AND currency = 'ETH'
         GROUP BY user_id
       )
       UPDATE wallets w
       SET balance = GREATEST(0, $1::numeric
         + COALESCE(d.deposit_sum, 0)
         - COALESCE(x.withdrawal_sum, 0)
         - COALESCE(b.wager_sum, 0)
         + COALESCE(b.payout_sum, 0))
       FROM wallets base
       LEFT JOIN deposit_totals d ON d.user_id = base.user_id
       LEFT JOIN withdrawal_totals x ON x.user_id = base.user_id
       LEFT JOIN bet_totals b ON b.user_id = base.user_id
       WHERE w.id = base.id
         AND base.chain = 'ethereum'
         AND base.currency = 'ETH'`,
      [defaultEthBalance],
    );

    await client.query('COMMIT');
    return {
      depositsPurged: depositDeletion.rowCount ?? 0,
      withdrawalsPurged: withdrawalDeletion.rowCount ?? 0,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
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
