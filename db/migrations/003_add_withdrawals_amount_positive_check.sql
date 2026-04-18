-- Migration: Add CHECK (amount > 0) to withdrawals
-- Run this on existing databases that were created before this constraint was added.
-- Fresh deployments use init.sql which already includes the constraint.
--
-- Usage: psql -U postgres -d dicetilt -f db/migrations/003_add_withdrawals_amount_positive_check.sql

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'withdrawals'::regclass
      AND conname = 'chk_withdrawals_amount_positive'
  ) THEN
    -- Fails if any rows have amount <= 0; fix those manually before re-running.
    ALTER TABLE withdrawals
    ADD CONSTRAINT chk_withdrawals_amount_positive CHECK (amount > 0);
  END IF;
END $$;
