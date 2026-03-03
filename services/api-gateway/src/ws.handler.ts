import { WebSocketServer, type WebSocket } from 'ws';
import type http from 'node:http';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import {
  ClientMessageSchema,
  WebSocketErrorCode,
  type BetResolvedEvent,
  type ServerMessage,
} from '@dicetilt/shared-types';
import { config } from './config.js';
import {
  checkSession,
  atomicBalanceDeduct,
  atomicBalanceCredit,
  getServerSeed,
  redisSub,
} from './redis.service.js';
import { pfCalculate } from './pf.client.js';
import { produceBetResolved } from './kafka.producer.js';
import {
  betsTotal,
  betProcessingDuration,
  redisLuaDuration,
  pfHashDuration,
  activeWsConnections,
  doubleSpendRejections,
  wagerVolumeTotal,
} from './metrics.js';

const clients = new Map<string, Set<WebSocket>>();

function sendJson(ws: WebSocket, msg: ServerMessage): void {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function sendError(ws: WebSocket, code: WebSocketErrorCode, message: string): void {
  sendJson(ws, { type: 'ERROR', code, message });
}

interface AuthenticatedRequest extends http.IncomingMessage {
  userId: string;
  walletAddress: string;
}

export function setupWebSocket(server: http.Server): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req: http.IncomingMessage, socket, head) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    if (url.pathname !== '/ws') {
      socket.destroy();
      return;
    }

    const token =
      url.searchParams.get('token') ??
      req.headers.authorization?.replace('Bearer ', '');

    if (!token) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    try {
      const payload = jwt.verify(token, config.jwtSecret) as { userId: string; walletAddress: string };
      (req as AuthenticatedRequest).userId = payload.userId;
      (req as AuthenticatedRequest).walletAddress = payload.walletAddress;
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
      });
    } catch {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
    }
  });

  wss.on('connection', async (ws: WebSocket, req: http.IncomingMessage) => {
    const { userId } = req as AuthenticatedRequest;

    const sessionActive = await checkSession(userId);

    if (!sessionActive) {
      sendJson(ws, { type: 'SESSION_REVOKED' });
      ws.close();
      return;
    }

    if (!clients.has(userId)) clients.set(userId, new Set());
    clients.get(userId)!.add(ws);
    activeWsConnections.inc();

    ws.on('close', () => {
      activeWsConnections.dec();
      clients.get(userId)?.delete(ws);
      if (clients.get(userId)?.size === 0) clients.delete(userId);
    });

    ws.on('message', async (raw) => {
      try {
        const data = JSON.parse(raw.toString());
        const parsed = ClientMessageSchema.safeParse(data);

        if (!parsed.success) {
          sendError(ws, WebSocketErrorCode.INVALID_PAYLOAD, 'Validation failed');
          return;
        }

        const msg = parsed.data;

        if (msg.type === 'PING') {
          sendJson(ws, { type: 'PONG' });
          return;
        }

        if (msg.type === 'BET_REQUEST') {
          await handleBet(ws, userId, msg);
        }
      } catch (err) {
        console.error('[WS] message error:', err);
        sendError(ws, WebSocketErrorCode.INTERNAL_ERROR, 'Internal server error');
      }
    });
  });

  setupPubSub();
  return wss;
}

async function handleBet(
  ws: WebSocket,
  userId: string,
  msg: { wagerAmount: number; clientSeed: string; chain: string; currency: string; target: number; direction: string },
): Promise<void> {
  const betStart = performance.now();
  const { wagerAmount, clientSeed, chain, currency, target, direction } = msg;

  // Fetch seed fresh from Redis on every bet — prevents stale seed after rotation.
  // Parallel with balance deduct so there is no added latency.
  const luaStart = performance.now();
  const [deductResult, serverSeed] = await Promise.all([
    atomicBalanceDeduct(userId, chain, currency, wagerAmount.toFixed(8)),
    getServerSeed(userId),
  ]);
  redisLuaDuration.observe(performance.now() - luaStart);

  if (!serverSeed) {
    if (deductResult.success) {
      atomicBalanceCredit(userId, chain, currency, wagerAmount.toFixed(8)).catch((err) =>
        console.error('[Redis] Seed-missing credit-back error:', err),
      );
    }
    sendError(ws, WebSocketErrorCode.INTERNAL_ERROR, 'Server seed not found');
    return;
  }

  if (!deductResult.success) {
    doubleSpendRejections.inc();
    sendError(ws, WebSocketErrorCode.INSUFFICIENT_BALANCE, 'Balance too low for this wager');
    return;
  }

  wagerVolumeTotal.inc({ chain, currency }, wagerAmount);

  const nonce = deductResult.nonce;
  const pfStart = performance.now();
  const { gameResult, gameHash } = await pfCalculate(clientSeed, nonce, serverSeed);
  pfHashDuration.observe(performance.now() - pfStart);

  const isWin =
    (direction === 'under' && gameResult < target) ||
    (direction === 'over' && gameResult > target);

  const winChance = direction === 'under' ? target - 1 : 100 - target;
  const multiplier = winChance > 0 ? 99 / winChance : 0;
  const payoutAmount = isWin ? wagerAmount * multiplier : 0;

  // Optimistic balance: use post-deduct balance for response.
  // Credit and Kafka publish are fire-and-forget to keep response latency minimal.
  const optimisticBalance = deductResult.newBalance;
  const betId = uuidv4();
  const event: BetResolvedEvent = {
    bet_id: betId,
    user_id: userId,
    chain: chain as 'ethereum' | 'solana',
    currency: currency as 'ETH' | 'SOL' | 'USDC' | 'USDT',
    wager_amount: wagerAmount.toFixed(8),
    payout_amount: payoutAmount.toFixed(8),
    game_result: gameResult,
    client_seed: clientSeed,
    nonce_used: nonce,
    outcome_hash: gameHash,
    executed_at: new Date().toISOString(),
  };

  // Fire credit + Kafka concurrently without blocking the response
  if (payoutAmount > 0) {
    atomicBalanceCredit(userId, chain, currency, payoutAmount.toFixed(8)).catch((err) =>
      console.error('[Redis] Credit error:', err),
    );
  }
  produceBetResolved(event).catch((err) =>
    console.error('[Kafka] BetResolved produce error:', err),
  );

  betsTotal.inc({ outcome: isWin ? 'win' : 'loss', chain, currency });
  betProcessingDuration.observe(performance.now() - betStart);

  sendJson(ws, {
    type: 'BET_RESULT',
    betId,
    gameResult,
    gameHash,
    nonce,
    wagerAmount,
    payoutAmount: Math.round(payoutAmount * 1e8) / 1e8,
    target,
    direction: direction as 'over' | 'under',
    multiplier: Math.round(multiplier * 10000) / 10000,
    newBalance: parseFloat(optimisticBalance),
    chain: chain as 'ethereum' | 'solana',
    currency: currency as 'ETH' | 'SOL' | 'USDC' | 'USDT',
    timestamp: event.executed_at,
  });
}

function setupPubSub(): void {
  redisSub.psubscribe('user:updates:*', (err) => {
    if (err) console.error('[Pub/Sub] subscribe error:', err);
    else console.log('[Pub/Sub] Subscribed to user:updates:*');
  });

  redisSub.on('pmessage', (_pattern, channel, message) => {
    const userId = channel.replace('user:updates:', '');
    const sockets = clients.get(userId);
    if (!sockets || sockets.size === 0) return;

    try {
      JSON.parse(message);
      for (const ws of sockets) {
        if (ws.readyState === ws.OPEN) {
          ws.send(message);
        }
      }
    } catch {
      // ignore malformed pub/sub messages
    }
  });
}
