import { v4 as uuidv4 } from 'uuid';
import { config } from './config.js';
import { createUserWithWallets, findUserByWalletAddress } from './db.js';
import { pfGenerateSeed } from './pf.client.js';
import { initUserRedisState, setSession } from './redis.service.js';
import { computeCommitment } from '@dicetilt/shared-types';

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
    // Postgres is the canonical balance authority. Redis hydration is conditional
    // (init-user-safe.lua only SETs when key is absent), so this is safe even
    // during in-flight bets — existing Redis keys are never overwritten.
    await initUserRedisState(
      userId,
      serverSeed,
      existing.ethBalance,
      existing.solBalance,
    );
  } else {
    userId = uuidv4();
    const seed = await pfGenerateSeed();
    serverSeed = seed.serverSeed;
    const commitment = computeCommitment(serverSeed);
    await createUserWithWallets(userId, serverSeed, walletAddress, commitment);

    await initUserRedisState(userId, serverSeed, config.defaultEthBalance, config.defaultSolBalance);
  }

  await setSession(userId);
  return userId;
}
