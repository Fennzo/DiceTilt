import { Router, type Request, type Response, type Router as RouterType } from 'express';
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import { config } from './config.js';
import { getServerSeed, getUserNonce, redis, checkSession } from './redis.service.js';
import { pfRotateSeed } from './pf.client.js';
import { updateServerSeed, insertSeedCommitment, revealSeedInAudit } from './db.js';
import { ChainSchema, CurrencySchema } from '@dicetilt/shared-types';

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

// Fix #3 — verify the session is still active (not revoked) before serving PF data.
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

  const serverCommitment = crypto.createHash('sha256').update(serverSeed).digest('hex');
  const currentNonce = await getUserNonce(userId, chain.data, currency.data);
  res.json({ serverCommitment, currentNonce });
});

router.post('/api/pf/rotate-seed', async (req: Request, res: Response) => {
  const userId = extractUserId(req, res);
  if (!userId) return;
  if (!(await checkActiveSession(userId, res))) return;

  try {
    const currentSeed = await getServerSeed(userId);
    if (!currentSeed) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    // M2 — Server-side verification: compute previousCommitment before rotation so
    // we can (a) verify SHA256(revealedSeed) === previousCommitment server-side, and
    // (b) include it in the response so the user can independently verify without
    // needing to remember which commitment was active.
    // NOTE: revealedSeed is still returned to the client — withholding it would break
    // provably fair (users must be able to independently re-derive game outcomes).
    const previousCommitment = crypto.createHash('sha256').update(currentSeed).digest('hex');

    const { revealedSeed, newServerSeed, newCommitment } = await pfRotateSeed(currentSeed);

    // M2 — Attest server-side verification: SHA256(revealedSeed) must equal the
    // commitment that was shown to the user before bets were placed.
    const verificationPassed = crypto.createHash('sha256').update(revealedSeed).digest('hex') === previousCommitment;

    if (!verificationPassed) {
      console.error('[PF] CRITICAL: Server-side verification failed — revealedSeed does not match previousCommitment');
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

      // Fix #15 — SCAN is cursor-based and non-blocking; safe under load.
      const nonceKeys: string[] = [];
      let cursor = '0';
      do {
        const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', `user:${userId}:nonce:*`, 'COUNT', 100);
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
      console.warn('[PF] Redis sync after seed rotation failed (non-fatal — recovers on re-auth):', redisErr);
    }

    // M2 — Response includes previousCommitment and serverVerified so users can:
    // 1. Independently confirm: SHA256(revealedServerSeed) === previousCommitment
    // 2. Trust that the server already verified this and attested the result
    res.json({ revealedServerSeed: revealedSeed, previousCommitment, newCommitment, serverVerified: verificationPassed });
  } catch (err) {
    console.error('[PF] rotate-seed error:', err);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

export { router as pfRouter };
