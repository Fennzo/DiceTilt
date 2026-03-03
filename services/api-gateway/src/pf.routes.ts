import { Router, type Request, type Response, type Router as RouterType } from 'express';
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import { config } from './config.js';
import { getServerSeed, getUserNonce, redis } from './redis.service.js';
import { pfRotateSeed } from './pf.client.js';
import { updateServerSeed } from './db.js';
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

router.get('/api/pf/status', async (req: Request, res: Response) => {
  const userId = extractUserId(req, res);
  if (!userId) return;

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

  try {
    const currentSeed = await getServerSeed(userId);
    if (!currentSeed) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    const { revealedSeed, newServerSeed, newCommitment } = await pfRotateSeed(currentSeed);

    await updateServerSeed(userId, newServerSeed, revealedSeed);
    await redis.set(`user:${userId}:serverSeed`, newServerSeed);

    const nonceKeys = await redis.keys(`user:${userId}:nonce:*`);
    if (nonceKeys.length > 0) {
      const pipeline = redis.pipeline();
      for (const key of nonceKeys) {
        pipeline.set(key, '0');
      }
      await pipeline.exec();
    }

    res.json({ revealedServerSeed: revealedSeed, newCommitment });
  } catch (err) {
    console.error('[PF] rotate-seed error:', err);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

export { router as pfRouter };
