-- Migration: Add revealed_pair_check to seed_commitment_audit
-- Ensures revealed_seed and revealed_at are always paired (both NULL or both NOT NULL).
-- Run this on existing databases that were created before this constraint was added.
--
-- Usage: psql -U postgres -d dicetilt -f db/migrations/004_add_seed_audit_revealed_pair_check.sql

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'seed_commitment_audit'::regclass
      AND conname = 'revealed_pair_check'
  ) THEN
    -- Fix rows with revealed_seed but no revealed_at (should not exist if trigger is correct)
    UPDATE seed_commitment_audit
    SET revealed_at = COALESCE(revealed_at, committed_at)
    WHERE revealed_seed IS NOT NULL AND revealed_at IS NULL;

    -- Fail if orphan revealed_at exists (cannot repair without seed)
    IF EXISTS (SELECT 1 FROM seed_commitment_audit WHERE revealed_seed IS NULL AND revealed_at IS NOT NULL) THEN
      RAISE EXCEPTION 'seed_commitment_audit: orphan revealed_at rows exist — fix manually before adding constraint';
    END IF;

    ALTER TABLE seed_commitment_audit
    ADD CONSTRAINT revealed_pair_check
      CHECK ((revealed_seed IS NULL AND revealed_at IS NULL) OR (revealed_seed IS NOT NULL AND revealed_at IS NOT NULL));
  END IF;
END $$;
