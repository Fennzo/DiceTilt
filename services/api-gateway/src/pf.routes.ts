import { Router, type Request, type Response, type Router as RouterType } from 'express';
import jwt from 'jsonwebtoken';
import { config } from './config.js';
import { getServerSeed, getUserNonce, redis, checkSession, checkRateLimit } from './redis.service.js';
import { pfRotateSeed } from './pf.client.js';
import { updateServerSeed, insertSeedCommitment, revealSeedInAudit } from './db.js';
import { ChainSchema, CurrencySchema, computeCommitment } from '@dicetilt/shared-types';
import { rateLimitRejections } from './metrics.js';
import { REDIS_SCAN_BATCH_SIZE } from './constants.js';
import { createLoggers } from '@dicetilt/logger';

const { app: log, security } = createLoggers('api-gateway');

const router: RouterType = Router();

function extractUserId(req: Request, res: Response): string | null {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) {
    res.status(401).json({ error: 'UNAUTHORIZED' });
    return null;
  }
  try {
    const payload = jwt.verify(token, config.jwtSecret) as { userId: string };
    return payload.userId;
  } catch {
    res.status(401).json({ error: 'UNAUTHORIZED' });
    return null;
  }
}

// Without this check, a user whose session was invalidated could still access
// their server seed commitment and rotate seeds.
async function checkActiveSession(userId: string, res: Response): Promise<boolean> {
  try {
    const active = await checkSession(userId);
    if (!active) {
      res.status(401).json({ error: 'SESSION_REVOKED' });
      return false;
    }
    return true;
  } catch {
    res.status(500).json({ error: 'INTERNAL_ERROR' });
    return false;
  }
}

router.get('/api/pf/status', async (req: Request, res: Response) => {
  const userId = extractUserId(req, res);
  if (!userId) return;
  if (!(await checkActiveSession(userId, res))) return;

  // Rate limit by IP for status checks.
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const allowed = await checkRateLimit(ip, 'pf_status', config.authRateLimitWindowSec, config.authRateLimitMax);
  if (!allowed) {
    rateLimitRejections.inc({ limiter_type: 'pf_status' });
    res.status(429).json({ error: 'TOO_MANY_REQUESTS' });
    return;
  }

  const chain = ChainSchema.safeParse(req.query['chain']);
  const currency = CurrencySchema.safeParse(req.query['currency']);
  if (!chain.success || !currency.success) {
    res.status(400).json({ error: 'chain and currency query params required' });
    return;
  }

  const serverSeed = await getServerSeed(userId);
  if (!serverSeed) {
    res.status(404).json({ error: 'User not found' });
    return;
  }

  const serverCommitment = computeCommitment(serverSeed);
  const currentNonce = await getUserNonce(userId, chain.data, currency.data);
  res.json({ serverCommitment, currentNonce });
});

router.post('/api/pf/rotate-seed', async (req: Request, res: Response) => {
  const userId = extractUserId(req, res);
  if (!userId) return;
  if (!(await checkActiveSession(userId, res))) return;

  // Rate limit by User ID for seed rotation (heavy operation).
  const allowed = await checkRateLimit(userId, 'pf_rotate', config.authRateLimitWindowSec, 5); // Max 5 rotations per minute
  if (!allowed) {
    rateLimitRejections.inc({ limiter_type: 'pf_rotate' });
    res.status(429).json({ error: 'TOO_MANY_REQUESTS', message: 'Too many seed rotations — slow down' });
    return;
  }

  try {
    const currentSeed = await getServerSeed(userId);
    if (!currentSeed) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    // we can (a) verify SHA256(revealedSeed) === previousCommitment server-side, and
    // (b) include it in the response so the user can independently verify without
    // needing to remember which commitment was active.
    // NOTE: revealedSeed is still returned to the client — withholding it would break
    // provably fair (users must be able to independently re-derive game outcomes).
    const previousCommitment = computeCommitment(currentSeed);

    const { revealedSeed, newServerSeed, newCommitment } = await pfRotateSeed(currentSeed);

    // Attest server-side verification: SHA256(revealedSeed) must equal the
    // commitment that was shown to the user before bets were placed.
    const verificationPassed = computeCommitment(revealedSeed) === previousCommitment;

    if (!verificationPassed) {
      security.error('Server-side seed verification failed', {
        event: 'SEED_VERIFICATION_FAILED',
        message: 'revealedSeed does not match previousCommitment'
      });
      // Consider: throw new Error('Seed verification failed');
    }

    // DB is the durable store — update it first. If this throws, nothing changes.
    await updateServerSeed(userId, newServerSeed, revealedSeed);

    // H2/M9 — Persist the reveal and new commitment to the immutable audit log.
    await revealSeedInAudit(userId, previousCommitment, revealedSeed);
    await insertSeedCommitment(userId, newCommitment);

    // Redis is a cache of DB state — failure here is non-fatal.
    // On next login, initUserRedisState() restores the DB seed to Redis automatically.
    try {
      await redis.set(`user:${userId}:serverSeed`, newServerSeed);

      const nonceKeys: string[] = [];
      let cursor = '0';
      do {
        const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', `user:${userId}:nonce:*`, 'COUNT', REDIS_SCAN_BATCH_SIZE);
        cursor = nextCursor;
        nonceKeys.push(...keys);
      } while (cursor !== '0');

      if (nonceKeys.length > 0) {
        const pipeline = redis.pipeline();
        for (const key of nonceKeys) {
          pipeline.set(key, '0');
        }
        await pipeline.exec();
      }
    } catch (redisErr) {
      log.warn('Redis sync after seed rotation failed (non-fatal — recovers on re-auth)', {
        event: 'REDIS_SYNC_ERROR',
        error: String(redisErr)
      });
    }

    // Response includes previousCommitment and serverVerified so users can:
    // 1. Independently confirm: SHA256(revealedServerSeed) === previousCommitment
    // 2. Trust that the server already verified this and attested the result
    res.json({ revealedServerSeed: revealedSeed, previousCommitment, newCommitment, serverVerified: verificationPassed });
  } catch (err) {
    log.error('Rotate-seed error', { event: 'ROTATE_SEED_ERROR', error: String(err) });
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

export { router as pfRouter };
