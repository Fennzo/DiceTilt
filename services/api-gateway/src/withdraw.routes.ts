import { Router, type Request, type Response, type Router as RouterType } from 'express';
import { v4 as uuidv4 } from 'uuid';
import jwt from 'jsonwebtoken';
import { WithdrawRequestSchema } from '@dicetilt/shared-types';
import { config } from './config.js';
import { checkSession, atomicBalanceDeduct, atomicBalanceCredit } from './redis.service.js';
import { getWalletAddress } from './db.js';
import { produceWithdrawalRequested } from './kafka.producer.js';
import { withdrawalRequests } from './metrics.js';
import { createLoggers, pseudonymize } from '@dicetilt/logger';

const { app: log, audit, security } = createLoggers('api-gateway');

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
      security.warn('Session revoked on withdraw', { event: 'SESSION_REVOKED', userId: pseudonymize(userId) });
      res.status(401).json({ error: 'SESSION_REVOKED' });
      return;
    }

    const parsed = WithdrawRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      security.warn('Invalid withdraw payload', { event: 'INVALID_PAYLOAD', userId: pseudonymize(userId), zodErrors: parsed.error.issues });
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
    try {
      await produceWithdrawalRequested({
        withdrawal_id: withdrawalId,
        user_id: userId,
        chain,
        currency,
        amount: amount.toFixed(8),
        to_address: toAddress,
        requested_at: new Date().toISOString(),
      });
    } catch (kafkaErr) {
      // Balance was deducted before Kafka publish. If publish fails, credit it back
      // to keep Redis balance consistent — the withdrawal never reached the payout worker.
      log.error('Kafka produce failed — crediting back deducted amount', { event: 'KAFKA_PRODUCE_ERROR', withdrawalId, userId: pseudonymize(userId), error: String(kafkaErr) });
      atomicBalanceCredit(userId, chain, currency, amount.toFixed(8)).catch((e: unknown) =>
        log.error('Critical: credit-back after Kafka failure also failed', { event: 'REDIS_CREDIT_ERROR', userId: pseudonymize(userId), payout: amount, chain, currency, error: String(e) }),
      );
      res.status(500).json({ error: 'INTERNAL_ERROR' });
      return;
    }

    withdrawalRequests.inc({ chain });
    audit.info('Withdrawal requested', { event: 'WITHDRAWAL_REQUESTED', userId: pseudonymize(userId), withdrawalId, amount, chain, currency, toAddress });
    res.status(202).json({ withdrawalId, status: 'PENDING' });
  } catch (err) {
    if (err instanceof jwt.JsonWebTokenError) {
      security.warn('JWT error on withdraw', { event: 'JWT_ERROR', path: '/api/v1/withdraw', error: String(err) });
      res.status(401).json({ error: 'INVALID_TOKEN' });
      return;
    }
    log.error('Withdraw error', { event: 'WITHDRAW_ERROR', error: String(err), stack: (err as Error).stack });
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

export { router as withdrawRouter };
