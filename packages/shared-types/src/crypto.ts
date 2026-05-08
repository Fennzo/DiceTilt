import crypto from 'node:crypto';

/**
 * Compute SHA-256 commitment hash for provably fair server seed.
 * Used across services to ensure consistent seed commitment generation.
 */
export function computeCommitment(serverSeed: string): string {
  return crypto.createHash('sha256').update(serverSeed).digest('hex');
}
