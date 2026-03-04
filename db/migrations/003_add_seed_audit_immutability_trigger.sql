-- Migration: Add prevent_audit_mutation trigger to seed_commitment_audit
-- Enforces append-only with one-time reveal (revealed_seed/revealed_at from NULL to NOT NULL).
-- Run this on existing databases that were created before this trigger was added.
--
-- Usage: psql -U postgres -d dicetilt -f db/migrations/003_add_seed_audit_immutability_trigger.sql

CREATE OR REPLACE FUNCTION prevent_audit_mutation()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'seed_commitment_audit: DELETE not allowed (immutable audit trail)';
    END IF;
    IF TG_OP = 'UPDATE' THEN
        IF OLD.revealed_seed IS NOT NULL THEN
            RAISE EXCEPTION 'seed_commitment_audit: UPDATE not allowed (row already revealed)';
        END IF;
        IF NEW.revealed_seed IS NULL OR NEW.revealed_at IS NULL THEN
            RAISE EXCEPTION 'seed_commitment_audit: UPDATE must set revealed_seed and revealed_at (one-time reveal only)';
        END IF;
        IF OLD.id IS DISTINCT FROM NEW.id OR OLD.user_id IS DISTINCT FROM NEW.user_id OR OLD.seed_commitment IS DISTINCT FROM NEW.seed_commitment OR OLD.committed_at IS DISTINCT FROM NEW.committed_at THEN
            RAISE EXCEPTION 'seed_commitment_audit: UPDATE may only set revealed_seed and revealed_at';
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_seed_audit_no_delete ON seed_commitment_audit;
DROP TRIGGER IF EXISTS trg_seed_audit_no_update ON seed_commitment_audit;

CREATE TRIGGER trg_seed_audit_no_delete
    BEFORE DELETE ON seed_commitment_audit
    FOR EACH ROW EXECUTE FUNCTION prevent_audit_mutation();

CREATE TRIGGER trg_seed_audit_no_update
    BEFORE UPDATE ON seed_commitment_audit
    FOR EACH ROW EXECUTE FUNCTION prevent_audit_mutation();
