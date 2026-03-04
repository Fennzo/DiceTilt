-- Migration: Add CHECK (amount > 0) to deposits
-- Run this on existing databases that were created before this constraint was added.
-- Fresh deployments use init.sql which already includes the constraint.
--
-- Usage: psql -U postgres -d dicetilt -f db/migrations/002_add_deposits_amount_positive_check.sql

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'deposits'::regclass
      AND conname = 'chk_deposits_amount_positive'
  ) THEN
    -- Fails if any rows have amount <= 0; fix those manually before re-running.
    ALTER TABLE deposits
    ADD CONSTRAINT chk_deposits_amount_positive CHECK (amount > 0);
  END IF;
END $$;
