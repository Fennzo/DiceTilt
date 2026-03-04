-- Migration: Add UNIQUE(tx_hash) to withdrawals for idempotency and deduplication
-- Run this on existing databases that were created before this constraint was added.
-- Fresh deployments use init.sql which already includes the constraint.
--
-- Usage: psql -U postgres -d dicetilt -f db/migrations/001_add_withdrawals_tx_hash_unique.sql
--
-- IMPORTANT: This migration acquires ACCESS EXCLUSIVE on withdrawals to prevent
-- concurrent inserts between DELETE and ALTER TABLE. Run during low traffic or
-- a maintenance window; the lock blocks all access to withdrawals until complete.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'withdrawals'::regclass
      AND conname = 'uq_withdrawals_tx_hash'
  ) THEN
    -- Acquire lock first so no concurrent inserts can create duplicates between
    -- DELETE and ALTER TABLE. Blocks all access to withdrawals until commit.
    LOCK TABLE withdrawals IN ACCESS EXCLUSIVE MODE;

    -- Remove duplicates first if any exist (keep one per tx_hash)
    -- First, backup duplicates that will be deleted
    -- Drop any stale backup from a previous failed run
    DROP TABLE IF EXISTS withdrawals_deleted_duplicates;

    CREATE TABLE withdrawals_deleted_duplicates AS
    SELECT w1.* FROM withdrawals w1
    JOIN withdrawals w2 ON w1.tx_hash = w2.tx_hash
    WHERE w1.withdrawal_id > w2.withdrawal_id;

    RAISE NOTICE 'Deleting % duplicate withdrawal records (backed up to withdrawals_deleted_duplicates)',
      (SELECT COUNT(*) FROM withdrawals w1 JOIN withdrawals w2 ON w1.tx_hash = w2.tx_hash WHERE w1.withdrawal_id > w2.withdrawal_id);

    DELETE FROM withdrawals w1
    USING withdrawals w2
    WHERE w1.tx_hash = w2.tx_hash
      AND w1.withdrawal_id > w2.withdrawal_id;

    ALTER TABLE withdrawals
    ADD CONSTRAINT uq_withdrawals_tx_hash UNIQUE (tx_hash);
  END IF;
END $$;
