import { Router, type Request, type Response, type Router as RouterType } from 'express';
import { PfCalculateRequestSchema, PfRotateSeedRequestSchema } from '@dicetilt/shared-types';
import { generateServerSeed, computeCommitment } from './crypto.service.js';
import { pool } from './pool.js';
import type { WorkerInput } from './worker.js';

const router: RouterType = Router();

function authGuard(req: Request, res: Response, next: () => void): void {
  const token = req.headers['x-pf-auth-token'];
  const expected = process.env['PF_AUTH_TOKEN'];
  if (!expected || token !== expected) {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }
  next();
}

router.post('/api/pf/generate-seed', authGuard, (_req: Request, res: Response) => {
  const serverSeed = generateServerSeed();
  const commitment = computeCommitment(serverSeed);
  res.json({ serverSeed, commitment });
});

router.post('/api/pf/calculate', authGuard, async (req: Request, res: Response) => {
  const parsed = PfCalculateRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid input', details: parsed.error.issues });
    return;
  }
  const { clientSeed, nonce, serverSeed } = parsed.data;
  const input: WorkerInput = { serverSeed, clientSeed, nonce };
  const result = await pool.run(input) as { gameResult: number; gameHash: string };
  res.json(result);
});

router.post('/api/pf/rotate-seed', authGuard, (req: Request, res: Response) => {
  const parsed = PfRotateSeedRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid input', details: parsed.error.issues });
    return;
  }
  const { currentServerSeed } = parsed.data;
  const newServerSeed = generateServerSeed();
  const newCommitment = computeCommitment(newServerSeed);
  res.json({
    revealedSeed: currentServerSeed,
    newServerSeed,
    newCommitment,
  });
});

router.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', service: 'provably-fair' });
});

export { router };
