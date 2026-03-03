import crypto from 'node:crypto';

export function generateServerSeed(): string {
  return crypto.randomBytes(32).toString('hex');
}

export function computeCommitment(serverSeed: string): string {
  return crypto.createHash('sha256').update(serverSeed).digest('hex');
}

export function computeGameResult(
  serverSeed: string,
  clientSeed: string,
  nonce: number,
): { gameResult: number; gameHash: string } {
  const hmac = crypto.createHmac('sha256', serverSeed);
  hmac.update(`${clientSeed}:${nonce}`);
  const gameHash = hmac.digest('hex');
  const gameResult = (parseInt(gameHash.slice(0, 5), 16) % 100) + 1;
  return { gameResult, gameHash };
}
