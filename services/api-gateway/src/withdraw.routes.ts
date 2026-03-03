import { Router, type Request, type Response, type Router as RouterType } from 'express';
import { v4 as uuidv4 } from 'uuid';
import jwt from 'jsonwebtoken';
import { WithdrawRequestSchema } from '@dicetilt/shared-types';
import { config } from './config.js';
import { checkSession } from './redis.service.js';
import { atomicBalanceDeduct } from './redis.service.js';
import { getWalletAddress } from './db.js';
import { produceWithdrawalRequested } from './kafka.producer.js';
import { withdrawalRequests } from './metrics.js';

const router: RouterType = Router();

interface JwtPayload {
  userId: string;
  walletAddress: string;
}

router.post('/api/v1/withdraw', async (req: Request, res: Response) => {
  const auth = req.headers.authorization?.replace('Bearer ', '');
  if (!auth) {
    res.status(401).json({ error: 'UNAUTHORIZED' });
    return;
  }
  try {
    const payload = jwt.verify(auth, config.jwtSecret) as JwtPayload;
    const { userId } = payload;

    const sessionActive = await checkSession(userId);
    if (!sessionActive) {
      res.status(401).json({ error: 'SESSION_REVOKED' });
      return;
    }

    const parsed = WithdrawRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'INVALID_PAYLOAD', details: parsed.error.issues });
      return;
    }

    const { amount, chain, currency } = parsed.data;
    const toAddress = await getWalletAddress(userId, chain, currency);
    if (!toAddress || toAddress === 'placeholder-solana-address') {
      res.status(400).json({ error: 'WALLET_NOT_FOUND', message: 'No wallet for this chain/currency' });
      return;
    }

    const deductResult = await atomicBalanceDeduct(
      userId,
      chain,
      currency,
      amount.toFixed(8),
    );

    if (!deductResult.success) {
      res.status(400).json({
        code: 'INSUFFICIENT_BALANCE',
        message: 'Insufficient balance for withdrawal',
      });
      return;
    }

    const withdrawalId = uuidv4();
    await produceWithdrawalRequested({
      withdrawal_id: withdrawalId,
      user_id: userId,
      chain,
      currency,
      amount: amount.toFixed(8),
      to_address: toAddress,
      requested_at: new Date().toISOString(),
    });

    withdrawalRequests.inc({ chain });
    res.status(202).json({ withdrawalId, status: 'PENDING' });
  } catch (err) {
    if (err instanceof jwt.JsonWebTokenError) {
      res.status(401).json({ error: 'INVALID_TOKEN' });
      return;
    }
    console.error('[Withdraw] error:', err);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

export { router as withdrawRouter };
