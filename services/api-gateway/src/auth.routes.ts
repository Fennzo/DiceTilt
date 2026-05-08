import { Router, type Request, type Response, type Router as RouterType } from 'express';
import { v4 as uuidv4 } from 'uuid';
import jwt from 'jsonwebtoken';
import { ethers } from 'ethers';
import { AuthVerifyRequestSchema } from '@dicetilt/shared-types';
import { config } from './config.js';
import { redis, getUserBalance, checkRateLimit } from './redis.service.js';
import { authFailures, rateLimitRejections } from './metrics.js'; 
import { createLoggers, pseudonymize } from '@dicetilt/logger';
import { upsertUserSessionByWallet } from './auth-user.service.js';

const { audit, security } = createLoggers('api-gateway');

const router: RouterType = Router();

// Challenges stored in Redis (key: challenge:{nonce}) so all cluster workers share
// the same store. Per-worker Map broke auth when challenge and verify hit different workers.
router.post('/api/v1/auth/challenge', async (req: Request, res: Response) => {
  // M3 — Rate limit by IP to prevent Redis key flood.
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const allowed = await checkRateLimit(ip, 'auth_challenge', config.authRateLimitWindowSec, config.authRateLimitMax);
  if (!allowed) {
    rateLimitRejections.inc({ limiter_type: 'auth_challenge' });
    security.warn('Auth challenge rate limit exceeded', { event: 'RATE_LIMITED', ip, action: 'auth_challenge' });
    res.status(429).json({ error: 'TOO_MANY_REQUESTS' });
    return;
  }

  const nonce = uuidv4();
  await redis.set(`challenge:${nonce}`, '1', 'PX', config.challengeTtlMs);
  res.json({ nonce });
});

router.post('/api/v1/auth/verify', async (req: Request, res: Response) => {
  // M3 — Rate limit by IP to prevent brute-force signature verification attempts.
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const allowed = await checkRateLimit(ip, 'auth_verify', config.authRateLimitWindowSec, config.authRateLimitMax);
  if (!allowed) {
    rateLimitRejections.inc({ limiter_type: 'auth_verify' });
    security.warn('Auth verify rate limit exceeded', { event: 'RATE_LIMITED', ip, action: 'auth_verify' });
    res.status(429).json({ error: 'TOO_MANY_REQUESTS' });
    return;
  }

  try {
    const parsed = AuthVerifyRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      security.warn('Invalid auth payload', { event: 'AUTH_FAILED', walletAddress: req.body?.walletAddress ?? '', reason: 'INVALID_PAYLOAD' });
      res.status(400).json({ error: 'INVALID_PAYLOAD', details: parsed.error.issues });
      return;
    }

    const { walletAddress: rawAddress, signature, nonce } = parsed.data;
    const walletAddress = rawAddress.toLowerCase();

    // GETDEL ensures the nonce is consumed exactly once — no replay possible,
    // and all cluster workers share the same store.
    const found = await redis.getdel(`challenge:${nonce}`);
    if (!found) {
      authFailures.inc();
      security.warn('Invalid or expired nonce', { event: 'AUTH_FAILED', walletAddress, reason: 'INVALID_NONCE' });
      res.status(401).json({ error: 'INVALID_NONCE' });
      return;
    }

    const recovered = ethers.verifyMessage(nonce, signature);
    if (recovered.toLowerCase() !== walletAddress) {
      authFailures.inc();
      security.warn('Invalid signature', { event: 'AUTH_FAILED', walletAddress, reason: 'INVALID_SIGNATURE' });
      res.status(401).json({ error: 'INVALID_SIGNATURE' });
      return;
    }

    const userId = await upsertUserSessionByWallet(walletAddress);
    const token = jwt.sign({ userId, walletAddress }, config.jwtSecret, { expiresIn: '24h' });
    audit.info('Auth success', { event: 'AUTH_SUCCESS', userId: pseudonymize(userId), walletAddress });
    res.json({ token });
  } catch (err) {
    authFailures.inc();
    security.warn('Auth verify error', { event: 'AUTH_FAILED', walletAddress: req.body?.walletAddress ?? '', reason: String(err) });
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

router.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', service: 'api-gateway' });
});

router.get('/api/v1/balance', async (req: Request, res: Response) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) { res.status(401).json({ error: 'UNAUTHORIZED' }); return; }
  try {
    const payload = jwt.verify(token, config.jwtSecret) as { userId: string };
    const eth = await getUserBalance(payload.userId, 'ethereum', 'ETH');
    const sol = await getUserBalance(payload.userId, 'solana', 'SOL');
    res.json({
      ethereum: { ETH: parseFloat(eth ?? config.defaultEthBalance) },
      solana:   { SOL: parseFloat(sol ?? config.defaultSolBalance) },
    });
  } catch {
    res.status(401).json({ error: 'INVALID_TOKEN' });
  }
});

router.get('/api/v1/config', (_req: Request, res: Response) => {
  res.json({
    treasuryContractAddress: config.treasuryContractAddress || null,
    evmRpcUrl: config.publicEvmRpcUrl,
  });
});


export { router as authRouter };
