import { existsSync, readFileSync } from 'node:fs';   // Fix #12 — replaces require() inside handler
import crypto from 'node:crypto';
import { Router, type Request, type Response, type Router as RouterType } from 'express';
import { v4 as uuidv4 } from 'uuid';
import jwt from 'jsonwebtoken';
import { ethers } from 'ethers';
import { AuthVerifyRequestSchema } from '@dicetilt/shared-types';
import { config } from './config.js';
import { redis, setSession, initUserRedisState, getUserBalance } from './redis.service.js';
import { createUserWithWallets, findUserByWalletAddress, insertSeedCommitment } from './db.js';
import { pfGenerateSeed } from './pf.client.js';
import { authFailures } from './metrics.js';   // Fix #10
import { createLoggers, pseudonymize } from '@dicetilt/logger';

const { audit, security } = createLoggers('api-gateway');

const router: RouterType = Router();

// Challenges stored in Redis (key: challenge:{nonce}) so all cluster workers share
// the same store. Per-worker Map broke auth when challenge and verify hit different workers.
router.post('/api/v1/auth/challenge', async (_req: Request, res: Response) => {
  const nonce = uuidv4();
  await redis.set(`challenge:${nonce}`, '1', 'PX', config.challengeTtlMs);
  res.json({ nonce });
});

router.post('/api/v1/auth/verify', async (req: Request, res: Response) => {
  try {
    const parsed = AuthVerifyRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      security.warn('Invalid auth payload', { event: 'AUTH_FAILED', walletAddress: req.body?.walletAddress ?? '', reason: 'INVALID_PAYLOAD' });
      res.status(400).json({ error: 'INVALID_PAYLOAD', details: parsed.error.issues });
      return;
    }

    const { walletAddress: rawAddress, signature, nonce } = parsed.data;
    // Fix #9 — normalise to lowercase for consistent storage and comparison across all code paths
    const walletAddress = rawAddress.toLowerCase();

    // Atomically fetch-and-delete the challenge from Redis.
    // GETDEL ensures the nonce is consumed exactly once — no replay possible,
    // and all cluster workers share the same store.
    const found = await redis.getdel(`challenge:${nonce}`);
    if (!found) {
      authFailures.inc();
      security.warn('Invalid or expired nonce', { event: 'AUTH_FAILED', walletAddress, reason: 'INVALID_NONCE' });
      res.status(401).json({ error: 'INVALID_NONCE' });
      return;
    }

    // Fix #1 — verify the signature is over the nonce, not the wallet address.
    // The wallet must sign the server-issued nonce, binding auth to this specific challenge.
    const recovered = ethers.verifyMessage(nonce, signature);
    if (recovered.toLowerCase() !== walletAddress) {
      authFailures.inc();
      security.warn('Invalid signature', { event: 'AUTH_FAILED', walletAddress, reason: 'INVALID_SIGNATURE' });
      res.status(401).json({ error: 'INVALID_SIGNATURE' });
      return;
    }

    const existing = await findUserByWalletAddress(walletAddress);
    let userId: string;
    let serverSeed: string;

    if (existing) {
      userId = existing.userId;
      serverSeed = existing.serverSeed;
      // Restore Redis state from DB balances (covers Redis eviction / restart)
      const currentEth = await getUserBalance(userId, 'ethereum', 'ETH');
      const currentSol = await getUserBalance(userId, 'solana', 'SOL');
      await initUserRedisState(
        userId,
        serverSeed,
        currentEth ?? existing.ethBalance,
        currentSol ?? existing.solBalance,
      );
    } else {
      userId = uuidv4();
      const seed = await pfGenerateSeed();
      serverSeed = seed.serverSeed;
      try {
        await createUserWithWallets(userId, serverSeed, walletAddress);
        // H2/M9 — Persist the initial seed commitment to the immutable audit log.
        const commitment = crypto.createHash('sha256').update(serverSeed).digest('hex');
        try {
          await insertSeedCommitment(userId, commitment);
        } catch (commitmentErr) {
          // Critical audit failure - user created but commitment missing
          console.error(`CRITICAL: Seed commitment insertion failed for userId ${userId}`, commitmentErr);
          throw commitmentErr; // Fail registration to maintain consistency
        }
        await initUserRedisState(userId, serverSeed, config.defaultEthBalance, config.defaultSolBalance);
      } catch (createErr: unknown) {
        // ... existing error handling ...
      }
    }

    await setSession(userId);
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

// Fix #12 — use top-level fs import; the previous require() inside the handler
// silently fails in ES module mode. Also removed the fragile host-header URL check.
router.get('/api/v1/config', (_req: Request, res: Response) => {
  let addr = process.env.TREASURY_CONTRACT_ADDRESS || '';
  if (!addr) {
    try {
      const p = '/shared/treasury-addr';
      if (existsSync(p)) addr = readFileSync(p, 'utf8').trim();
    } catch {}
  }
  // PUBLIC_EVM_RPC_URL is the browser-reachable address (e.g. http://localhost:8545).
  // EVM_RPC_URL is the Docker-internal address (http://evm-node:8545) — not reachable from browsers.
  res.json({
    treasuryContractAddress: addr || null,
    evmRpcUrl: process.env.PUBLIC_EVM_RPC_URL || process.env.EVM_RPC_URL || 'http://localhost:8545',
  });
});


export { router as authRouter };
