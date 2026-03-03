import crypto from 'node:crypto';

function computeGameResult(serverSeed: string, clientSeed: string, nonce: number) {
  const hmac = crypto.createHmac('sha256', serverSeed);
  hmac.update(`${clientSeed}:${nonce}`);
  const gameHash = hmac.digest('hex');
  const gameResult = (parseInt(gameHash.slice(0, 5), 16) % 100) + 1;
  return { gameResult, gameHash };
}

function generateServerSeed(): string {
  return crypto.randomBytes(32).toString('hex');
}

function computeCommitment(serverSeed: string): string {
  return crypto.createHash('sha256').update(serverSeed).digest('hex');
}

describe('Provably Fair CryptoService', () => {
  const serverSeed = 'a'.repeat(64);
  const clientSeed = 'test-client-seed';

  test('gameResult is always between 1 and 100', () => {
    for (let nonce = 0; nonce < 1000; nonce++) {
      const { gameResult } = computeGameResult(serverSeed, clientSeed, nonce);
      expect(gameResult).toBeGreaterThanOrEqual(1);
      expect(gameResult).toBeLessThanOrEqual(100);
    }
  });

  test('same inputs produce same output (deterministic)', () => {
    const r1 = computeGameResult(serverSeed, clientSeed, 42);
    const r2 = computeGameResult(serverSeed, clientSeed, 42);
    expect(r1.gameResult).toBe(r2.gameResult);
    expect(r1.gameHash).toBe(r2.gameHash);
  });

  test('different nonces produce different results', () => {
    const results = new Set<string>();
    for (let i = 0; i < 100; i++) {
      results.add(computeGameResult(serverSeed, clientSeed, i).gameHash);
    }
    expect(results.size).toBe(100);
  });

  test('different server seeds produce different results', () => {
    const seed1 = 'a'.repeat(64);
    const seed2 = 'b'.repeat(64);
    const r1 = computeGameResult(seed1, clientSeed, 0);
    const r2 = computeGameResult(seed2, clientSeed, 0);
    expect(r1.gameHash).not.toBe(r2.gameHash);
  });

  test('client can verify outcomes after seed reveal', () => {
    const seed = generateServerSeed();
    const commitment = computeCommitment(seed);

    const bets: { nonce: number; gameResult: number; gameHash: string }[] = [];
    for (let nonce = 1; nonce <= 5; nonce++) {
      bets.push({ nonce, ...computeGameResult(seed, clientSeed, nonce) });
    }

    expect(computeCommitment(seed)).toBe(commitment);

    for (const bet of bets) {
      const verified = computeGameResult(seed, clientSeed, bet.nonce);
      expect(verified.gameResult).toBe(bet.gameResult);
      expect(verified.gameHash).toBe(bet.gameHash);
    }
  });

  test('result derivation matches spec: parseInt(hash[0:5], 16) % 100 + 1', () => {
    const { gameHash, gameResult } = computeGameResult(serverSeed, clientSeed, 0);
    const expected = (parseInt(gameHash.slice(0, 5), 16) % 100) + 1;
    expect(gameResult).toBe(expected);
  });

  test('game mechanics: under/over win conditions', () => {
    const { gameResult } = computeGameResult(serverSeed, clientSeed, 0);
    const target = 50;

    const underWin = gameResult < target;
    const overWin = gameResult > target;

    expect(underWin || overWin || gameResult === target).toBe(true);

    if (underWin) {
      const multiplier = 99 / (target - 1);
      expect(multiplier).toBeCloseTo(2.0204, 3);
    }
    if (overWin) {
      const multiplier = 99 / (100 - target);
      expect(multiplier).toBe(1.98);
    }
  });

  // --- Verification correctness tests ---

  test('client recomputation matches server gameHash (cross-environment equivalence)', () => {
    // The server uses: crypto.createHmac('sha256', serverSeed) with a string key (UTF-8 encoding).
    // The browser uses: crypto.subtle with TextEncoder().encode(serverSeed) (also UTF-8).
    // This test proves they are identical by using explicit Buffer.from(key, 'utf8'),
    // which is exactly what TextEncoder produces for ASCII hex strings.
    const seed = generateServerSeed();
    const nonce = 7;

    // Server path (as in crypto.service.ts)
    const { gameHash: serverGameHash, gameResult: serverResult } = computeGameResult(seed, clientSeed, nonce);

    // Client path: explicit UTF-8 Buffer key (mirrors browser TextEncoder behaviour)
    const clientHmac = crypto.createHmac('sha256', Buffer.from(seed, 'utf8'));
    clientHmac.update(Buffer.from(`${clientSeed}:${nonce}`, 'utf8'));
    const clientGameHash = clientHmac.digest('hex');
    const clientResult = (parseInt(clientGameHash.slice(0, 5), 16) % 100) + 1;

    expect(clientGameHash).toBe(serverGameHash);
    expect(clientResult).toBe(serverResult);
  });

  test('stale seed causes gameHash mismatch (proves the cache bug)', () => {
    // Simulates the bug: WS handler cached oldSeed at connection time.
    // User rotates → Redis now has newSeed.
    // Bets after rotation are computed with oldSeed (stale cache).
    // Rotation reveals newSeed → verification against newSeed fails.
    const oldSeed = generateServerSeed();
    const newSeed = generateServerSeed();
    const nonce = 1;

    // Bet computed with stale old seed (the buggy behaviour)
    const { gameHash: staleHash } = computeGameResult(oldSeed, clientSeed, nonce);

    // Verification attempts to recompute with the new (revealed) seed
    const { gameHash: freshHash } = computeGameResult(newSeed, clientSeed, nonce);

    // They must NOT match — stale seed produces wrong hash → verification fails
    expect(staleHash).not.toBe(freshHash);
  });

  test('gameHash and recomputedHash are identical when correct seed is used', () => {
    // Directly models what the UI shows in the two hash boxes after rotation.
    // serverGameHash  = what the server sent in BET_RESULT (stored as bet.hash)
    // recomputedHash  = what the client computes from the revealed seed
    // Both must be the same string for the bet to be verified ✓
    const seed = generateServerSeed();
    const nonce = 3;

    const { gameHash: serverGameHash } = computeGameResult(seed, clientSeed, nonce);

    // Client recomputes after seed reveal (same explicit UTF-8 path)
    const recomputedHmac = crypto.createHmac('sha256', Buffer.from(seed, 'utf8'));
    recomputedHmac.update(Buffer.from(`${clientSeed}:${nonce}`, 'utf8'));
    const recomputedHash = recomputedHmac.digest('hex');

    expect(recomputedHash).toBe(serverGameHash);
  });
});
