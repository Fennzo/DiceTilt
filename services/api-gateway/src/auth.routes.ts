import { Router, type Request, type Response, type Router as RouterType } from 'express';
import { v4 as uuidv4 } from 'uuid';
import jwt from 'jsonwebtoken';
import { ethers } from 'ethers';
import { AuthVerifyRequestSchema } from '@dicetilt/shared-types';
import { config } from './config.js';
import { setSession, initUserRedisState, getUserBalance } from './redis.service.js';
import { createUserWithWallets, findUserByWalletAddress } from './db.js';
import { pfGenerateSeed } from './pf.client.js';

const router: RouterType = Router();
const challengeStore = new Map<string, { nonce: string; expiresAt: number }>();

router.post('/api/v1/auth/challenge', (_req: Request, res: Response) => {
  const nonce = uuidv4();
  challengeStore.set(nonce, { nonce, expiresAt: Date.now() + 5 * 60 * 1000 });
  res.json({ nonce });
});

router.post('/api/v1/auth/verify', async (req: Request, res: Response) => {
  try {
    const parsed = AuthVerifyRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'INVALID_PAYLOAD', details: parsed.error.issues });
      return;
    }

    const { walletAddress, signature } = parsed.data;

    const recovered = ethers.verifyMessage(walletAddress, signature);
    if (recovered.toLowerCase() !== walletAddress.toLowerCase()) {
      res.status(401).json({ error: 'INVALID_SIGNATURE' });
      return;
    }

    // Reuse existing user if this wallet has logged in before
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
      await createUserWithWallets(userId, serverSeed, walletAddress);
      await initUserRedisState(userId, serverSeed, config.defaultEthBalance, config.defaultSolBalance);
    }

    await setSession(userId);

    const token = jwt.sign({ userId, walletAddress }, config.jwtSecret, { expiresIn: '24h' });
    res.json({ token });
  } catch (err) {
    console.error('[Auth] verify error:', err);
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

router.get('/api/v1/config', (req: Request, res: Response) => {
  let addr = process.env.TREASURY_CONTRACT_ADDRESS || '';
  if (!addr) {
    try {
      const fs = require('node:fs');
      const p = '/shared/treasury-addr';
      if (fs.existsSync(p)) addr = fs.readFileSync(p, 'utf8').trim();
    } catch {}
  }
  const evmRpc = process.env.EVM_RPC_URL || 'http://localhost:8545';
  res.json({
    treasuryContractAddress: addr,
    evmRpcUrl: req.headers.host?.includes('localhost') ? 'http://localhost:8545' : evmRpc,
  });
});

setInterval(() => {
  const now = Date.now();
  for (const [key, val] of challengeStore) {
    if (val.expiresAt < now) challengeStore.delete(key);
  }
}, 60_000);

export { router as authRouter };
