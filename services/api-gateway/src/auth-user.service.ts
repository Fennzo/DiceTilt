import crypto from 'node:crypto';
import { v4 as uuidv4 } from 'uuid';
import { config } from './config.js';
import { createUserWithWallets, findUserByWalletAddress } from './db.js';
import { pfGenerateSeed } from './pf.client.js';
import { getUserBalance, initUserRedisState, setSession } from './redis.service.js';

/**
 * Shared wallet auth bootstrap used by both signed auth and TEST_MODE dev auth:
 * - find or create DB user by wallet address
 * - hydrate/repair Redis state from canonical DB values
 * - create/refresh active session key
 */
export async function upsertUserSessionByWallet(walletAddress: string): Promise<string> {
  const existing = await findUserByWalletAddress(walletAddress);
  let userId: string;
  let serverSeed: string;

  if (existing) {
    userId = existing.userId;
    serverSeed = existing.serverSeed;
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
    const commitment = crypto.createHash('sha256').update(serverSeed).digest('hex');
    await createUserWithWallets(userId, serverSeed, walletAddress, commitment);

    await initUserRedisState(userId, serverSeed, config.defaultEthBalance, config.defaultSolBalance);
  }

  await setSession(userId);
  return userId;
}
