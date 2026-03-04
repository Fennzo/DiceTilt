/**
 * One-way pseudonymization for user identifiers in logs.
 * Uses HMAC-SHA256 with a keyed secret — non-reversible, no plaintext storage.
 * Supports key versioning for rotation: change PSEUDONYM_KEY_VERSION to invalidate
 * prior pseudonyms (new version = new hashes; old logs keep old pseudonyms).
 *
 * Config: PSEUDONYM_SECRET (env), PSEUDONYM_KEY_VERSION (env, default '1').
 * See config.ts and .env.example. Key rotation: increment PSEUDONYM_KEY_VERSION.
 */
import crypto from 'node:crypto';

const PREFIX = 'usr';

/**
 * Pseudonymize a user ID for safe logging. Returns a short, deterministic,
 * non-reversible token (e.g. usr_a1b2c3d4e5f6) so logs remain queryable
 * without exposing PII.
 *
 * @param userId - Raw user ID (UUID or similar)
 * @returns Pseudonym string, e.g. "usr_a1b2c3d4e5f6"
 */
export function pseudonymize(userId: string): string {
  if (!userId || typeof userId !== 'string') return `${PREFIX}_???`;
  const secret = process.env['PSEUDONYM_SECRET'];
  if (!secret) {
    if (process.env['NODE_ENV'] === 'production') {
      throw new Error('PSEUDONYM_SECRET must be set in production');
    }
    // Fall through to use a dev-only default
  }
  const effectiveSecret = secret ?? 'dev-pseudonym-secret-not-for-production';
  const keyVersion = process.env['PSEUDONYM_KEY_VERSION'] ?? '1';
  const input = `${keyVersion}:${userId}`;
  const hmac = crypto.createHmac('sha256', effectiveSecret);
  hmac.update(input, 'utf8');
  const hash = hmac.digest('hex');
  return `${PREFIX}_${hash.slice(0, 12)}`;
}
