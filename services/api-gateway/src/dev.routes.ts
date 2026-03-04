/**
 * dev.routes.ts — TEST_MODE-only endpoints for k6 load testing.
 * NEVER expose in production (mounted only when config.testMode === true).
 */
import { Router, type Request, type Response, type Router as RouterType } from 'express';
import { v4 as uuidv4 } from 'uuid';
import jwt from 'jsonwebtoken';
import { ethers } from 'ethers';
import { config } from './config.js';
import { setSession, initUserRedisState, getUserBalance } from './redis.service.js';
import { createUserWithWallets, findUserByWalletAddress } from './db.js';
import { pfGenerateSeed } from './pf.client.js';

const router: RouterType = Router();

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

    const existing = await findUserByWalletAddress(walletAddress);
    let userId: string;
    let serverSeed: string;

    if (existing) {
      userId = existing.userId;
      serverSeed = existing.serverSeed;
      // Read current Redis balance first (same as auth.routes.ts) so a post-login
      // deposit that updated Redis is not overwritten with the stale DB value.
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
    res.json({ token, userId, walletAddress, walletIndex: idx });
  } catch (err) {
    console.error('[Dev] token error:', err);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

// Hardhat account #0 private key (from the deterministic mnemonic, index 0)
// This is the deployer/funder account — pre-funded with 10,000 ETH on Anvil.
const HARDHAT_0_PRIVKEY = ethers.HDNodeWallet.fromMnemonic(
  ethers.Mnemonic.fromPhrase(HARDHAT_MNEMONIC),
  "m/44'/60'/0'/0/0",
).privateKey;

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
  const { address, amount = 10 } = req.body as { address?: string; amount?: number };

  if (!address || !ethers.isAddress(address)) {
    res.status(400).json({ error: 'Invalid address' });
    return;
  }

  const sendAmount = Math.min(Math.max(Number(amount) || 10, 0.01), 100);

  try {
    const provider = new ethers.JsonRpcProvider(config.evmRpcUrl);
    const funder   = new ethers.Wallet(HARDHAT_0_PRIVKEY, provider);
    const tx = await funder.sendTransaction({
      to:    address,
      value: ethers.parseEther(sendAmount.toString()),
    });
    res.json({ txHash: tx.hash, address, amount: sendAmount });
  } catch (err) {
    console.error('[Dev] faucet error:', err);
    res.status(500).json({ error: 'FAUCET_ERROR', detail: String(err) });
  }
});

export { router as devRouter };
