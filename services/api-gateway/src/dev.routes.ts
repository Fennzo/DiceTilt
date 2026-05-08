import { Router, type Request, type Response, type Router as RouterType } from 'express';
import jwt from 'jsonwebtoken';
import { ethers } from 'ethers';
import { config } from './config.js';
import { checkRateLimit } from './redis.service.js';
import { rateLimitRejections } from './metrics.js';
import { upsertUserSessionByWallet } from './auth-user.service.js';
import { createLoggers } from '@dicetilt/logger';
import { FAUCET_DEFAULT_AMOUNT, FAUCET_MIN_AMOUNT, FAUCET_MAX_AMOUNT } from './constants.js';

const router: RouterType = Router();
const { app: log } = createLoggers('api-gateway');

// Hardhat/Anvil deterministic mnemonic — same as Metamask demo mode in frontend
const HARDHAT_MNEMONIC = 'test test test test test test test test test test test junk';

/**
 * GET /api/v1/dev/token?walletIndex=N
 * Returns a JWT for Hardhat account #N without requiring ECDSA signature.
 * Used by k6 scripts which cannot do secp256k1 signing.
 */
router.get('/api/v1/dev/token', async (req: Request, res: Response) => {
  if (!config.testMode || process.env['NODE_ENV'] === 'production') {
    res.status(404).end();
    return;
  }

  // Rate limit by IP for dev token requests.
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const allowed = await checkRateLimit(ip, 'dev_token', config.authRateLimitWindowSec, config.authRateLimitMax);
  if (!allowed) {
    rateLimitRejections.inc({ limiter_type: 'dev_token' });
    res.status(429).json({ error: 'TOO_MANY_REQUESTS' });
    return;
  }

  const idx = parseInt((req.query['walletIndex'] as string) ?? '0', 10);
  if (isNaN(idx) || idx < 0 || idx > 9999) {
    res.status(400).json({ error: 'walletIndex must be 0-9999' });
    return;
  }

  try {
    const wallet = ethers.HDNodeWallet.fromMnemonic(
      ethers.Mnemonic.fromPhrase(HARDHAT_MNEMONIC),
      `m/44'/60'/0'/0/${idx}`,
    );
    const walletAddress = wallet.address;

    const userId = await upsertUserSessionByWallet(walletAddress);

    const token = jwt.sign({ userId, walletAddress }, config.jwtSecret, { expiresIn: '24h' });
    res.json({ token, userId, walletAddress, walletIndex: idx });
  } catch (err) {
    log.error('Dev token error', { event: 'DEV_TOKEN_ERROR', walletIndex: idx, error: String(err) });
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

/**
 * POST /api/v1/dev/faucet
 * Body: { address: string, amount?: number }
 * Sends ETH from Hardhat #0 to the given address on the local Anvil node.
 * Used to fund newly created localhost wallets so they can test deposits.
 */
router.post('/api/v1/dev/faucet', async (req: Request, res: Response) => {
  if (!config.testMode || process.env['NODE_ENV'] === 'production') {
    res.status(404).end();
    return;
  }
  const { address, amount = FAUCET_DEFAULT_AMOUNT } = req.body as { address?: string; amount?: number };

  if (!address || !ethers.isAddress(address)) {
    res.status(400).json({ error: 'Invalid address' });
    return;
  }

  const sendAmount = Math.min(Math.max(Number(amount) || FAUCET_DEFAULT_AMOUNT, FAUCET_MIN_AMOUNT), FAUCET_MAX_AMOUNT);

  try {
    const provider = new ethers.JsonRpcProvider(config.evmRpcUrl);
    // Derive only when endpoint is called so test mnemonic material is not loaded
    // into process memory during non-dev route usage.
    const funderPrivKey = ethers.HDNodeWallet.fromMnemonic(
      ethers.Mnemonic.fromPhrase(HARDHAT_MNEMONIC),
      "m/44'/60'/0'/0/0",
    ).privateKey;
    const funder   = new ethers.Wallet(funderPrivKey, provider);
    const tx = await funder.sendTransaction({
      to:    address,
      value: ethers.parseEther(sendAmount.toString()),
    });
    res.json({ txHash: tx.hash, address, amount: sendAmount });
  } catch (err) {
    log.error('Dev faucet error', { event: 'DEV_FAUCET_ERROR', address, amount: sendAmount, error: String(err) });
    res.status(500).json({ error: 'FAUCET_ERROR' });
  }
});

export { router as devRouter };
