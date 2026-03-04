import { WebSocketServer, type WebSocket } from 'ws';
import type http from 'node:http';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import {
  ClientMessageSchema,
  AuthMessageSchema,
  WebSocketErrorCode,
  type BetResolvedEvent,
  type ServerMessage,
} from '@dicetilt/shared-types';
import { config } from './config.js';
import {
  checkSession,
  atomicEscrowBet,
  atomicSettleBet,
  atomicReleaseEscrow,
  getServerSeed,
  checkRateLimit,
  redisSub,
  type EscrowResult,
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
  rateLimitRejections,
  rateLimitRedisErrors,
  redisErrorRejections,
  authFailures,
} from './metrics.js';
import { createLoggers, pseudonymize } from '@dicetilt/logger';

const { app: log, audit, security } = createLoggers('api-gateway');

// C3/H6 — Escrow error path: release escrowed wager back to available balance.
// Retries with exponential backoff — a transient Redis error must not silently
// strand funds in the escrow key.
async function releaseEscrowWithRetry(
  userId: string,
  chain: string,
  currency: string,
  wagerAmount: string,
  maxAttempts = config.creditMaxAttempts,
): Promise<void> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await atomicReleaseEscrow(userId, chain, currency, wagerAmount);
      return;
    } catch (err) {
      if (attempt === maxAttempts) {
        log.error('Escrow release failed after all retries', {
          event: 'REDIS_CREDIT_ERROR',
          userId: pseudonymize(userId), wagerAmount, chain, currency,
          attempts: maxAttempts,
          error: String(err),
        });
        return;
      }
      await new Promise((r) => setTimeout(r, config.creditRetryBaseMs * Math.pow(2, attempt - 1)));
    }
  }
}

// C3/H6 — Settle bet: release wager from escrow and credit payout (0 on loss).
// Runs fire-and-forget after BET_RESULT is sent to preserve P95 <20ms SLO.
async function settleBetAsync(
  userId: string,
  chain: string,
  currency: string,
  wagerAmount: string,
  payoutAmount: string,
  maxAttempts = config.creditMaxAttempts,
): Promise<void> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await atomicSettleBet(userId, chain, currency, wagerAmount, payoutAmount);
      return;
    } catch (err) {
      if (attempt === maxAttempts) {
        log.error('Bet settle failed after all retries', {
          event: 'REDIS_CREDIT_ERROR',
          userId: pseudonymize(userId), wagerAmount, payoutAmount, chain, currency,
          attempts: maxAttempts,
          error: String(err),
        });
        return;
      }
      await new Promise((r) => setTimeout(r, config.creditRetryBaseMs * Math.pow(2, attempt - 1)));
    }
  }
}

const clients = new Map<string, Set<WebSocket>>();

function sendJson(ws: WebSocket, msg: ServerMessage): void {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function sendError(ws: WebSocket, code: WebSocketErrorCode, message: string): void {
  sendJson(ws, { type: 'ERROR', code, message });
}

export function setupWebSocket(server: http.Server): WebSocketServer {
  // Fix #5 — cap incoming WS frame size (default 100 MB → exhausts memory on attack).
  const wss = new WebSocketServer({ noServer: true, maxPayload: config.wsMaxPayloadBytes });

  server.on('upgrade', (req: http.IncomingMessage, socket, head) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    if (url.pathname !== '/ws') {
      socket.destroy();
      return;
    }
    // Fix #8 — do NOT authenticate during the HTTP upgrade.
    // A JWT in the URL query string is recorded in Nginx access logs and browser history.
    // Authentication now happens in the first WebSocket frame (AUTH message).
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws: WebSocket, _req: http.IncomingMessage) => {
    // Fix #8 — enforce an auth window to receive the AUTH frame.
    // Unauthenticated sockets that never send AUTH are closed automatically,
    // preventing idle socket accumulation.
    const authTimeout = setTimeout(() => {
      if (ws.readyState === ws.OPEN) {
        authFailures.inc();
        security.warn('WS auth timeout — closing unauthenticated socket', { event: 'WS_AUTH_TIMEOUT' });
        ws.close(1008, 'authentication timeout');
      }
    }, config.wsAuthTimeoutMs);

    // Clear the timer if the socket closes before the AUTH frame arrives.
    ws.once('close', () => clearTimeout(authTimeout));

    ws.once('message', async (raw) => {
      clearTimeout(authTimeout);

      // Validate the first frame as an AUTH message.
      let authFrame: { type: 'AUTH'; token: string };
      try {
        authFrame = AuthMessageSchema.parse(JSON.parse(raw.toString()));
      } catch {
        authFailures.inc();
        security.warn('Invalid WS auth frame', { event: 'JWT_ERROR', path: '/ws' });
        ws.close(1008, 'first frame must be AUTH');
        return;
      }

      let userId: string;
      let walletAddress: string;
      try {
        const payload = jwt.verify(authFrame.token, config.jwtSecret) as { userId: string; walletAddress: string };
        userId = payload.userId;
        walletAddress = payload.walletAddress;
      } catch (err) {
        authFailures.inc();
        security.warn('JWT error on WS first frame', { event: 'JWT_ERROR', path: '/ws', error: String(err) });
        ws.close(1008, 'invalid token');
        return;
      }

      let sessionActive: boolean;
      try {
        sessionActive = await checkSession(userId);
      } catch (err) {
        log.error('checkSession error — closing connection', { event: 'WS_MESSAGE_ERROR', userId: pseudonymize(userId), error: String(err), stack: (err as Error).stack });
        sendError(ws, WebSocketErrorCode.INTERNAL_ERROR, 'Service temporarily unavailable');
        ws.close();
        return;
      }

      if (!sessionActive) {
        authFailures.inc();
        security.warn('Session revoked on connect', { event: 'SESSION_REVOKED', userId: pseudonymize(userId) });
        sendJson(ws, { type: 'SESSION_REVOKED' });
        ws.close();
        return;
      }

      // Fix #6 — enforce per-user connection limit. Add first, then re-check atomically:
      // if we exceeded the limit (race with concurrent connections), remove and reject.
      if (!clients.has(userId)) clients.set(userId, new Set());
      clients.get(userId)!.add(ws);
      activeWsConnections.inc();

      const userConns = clients.get(userId)!;
      if (userConns.size > config.maxWsConnectionsPerUser) {
        userConns.delete(ws);
        activeWsConnections.dec();
        authFailures.inc();
        security.warn('WS connection limit exceeded', { event: 'WS_CONN_LIMIT', userId: pseudonymize(userId), limit: config.maxWsConnectionsPerUser });
        ws.close(1008, 'connection limit reached');
        return;
      }

      // Fix #8 — confirm successful auth to the client before accepting game messages.
      sendJson(ws, { type: 'AUTH_OK' });
      log.info('WebSocket authenticated', { event: 'WS_CONNECTED', userId: pseudonymize(userId), walletAddress: pseudonymize(walletAddress) });

      ws.on('close', () => {
        activeWsConnections.dec();
        clients.get(userId)?.delete(ws);
        if (clients.get(userId)?.size === 0) clients.delete(userId);
        log.info('WebSocket disconnected', { event: 'WS_DISCONNECTED', userId: pseudonymize(userId) });
      });

      ws.on('message', async (rawMsg) => {
        try {
          const data = JSON.parse(rawMsg.toString());
          const parsed = ClientMessageSchema.safeParse(data);

          if (!parsed.success) {
            security.warn('Invalid WebSocket payload', { event: 'INVALID_PAYLOAD', userId: pseudonymize(userId), zodErrors: parsed.error.issues });
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
          log.error('WebSocket message error', { event: 'WS_MESSAGE_ERROR', userId: pseudonymize(userId), error: String(err), stack: (err as Error).stack });
          sendError(ws, WebSocketErrorCode.INTERNAL_ERROR, 'Internal server error');
        }
      });
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

  // Sliding-window rate limit: checked before any balance operation to reject cheaply.
  // Fail closed on Redis errors — reject bet and return INTERNAL_ERROR (secure default).
  try {
    const allowed = await checkRateLimit(userId, 'bet', config.betRateLimitWindowSec, config.betRateLimitMax);
    if (!allowed) {
      rateLimitRejections.inc({ limiter_type: 'bet' });
      security.warn('Rate limit exceeded', { event: 'RATE_LIMITED', userId: pseudonymize(userId), action: 'bet' });
      sendError(ws, WebSocketErrorCode.RATE_LIMITED, 'Too many bets — slow down');
      return;
    }
  } catch (err) {
    rateLimitRedisErrors.inc();
    redisErrorRejections.inc();
    log.error('Redis error on rate limit check — rejecting bet (fail closed)', {
      event: 'REDIS_UNAVAILABLE',
      userId: pseudonymize(userId),
      error: String(err),
      stack: (err as Error).stack,
    });
    security.warn('Bet rejected due to Redis unavailability', { event: 'REDIS_UNAVAILABLE', userId: pseudonymize(userId), path: 'rate_limit' });
    sendError(ws, WebSocketErrorCode.INTERNAL_ERROR, 'Service temporarily unavailable');
    return;
  }

  // C3/H6 — Escrow wager atomically: deducts from balance_available into balance_escrowed
  // and increments nonce. Fetch seed in parallel — no added latency.
  const luaStart = performance.now();
  let escrowResult: EscrowResult;
  let serverSeed: string | null;
  try {
    [escrowResult, serverSeed] = await Promise.all([
      atomicEscrowBet(userId, chain, currency, wagerAmount.toFixed(8)),
      getServerSeed(userId),
    ]);
  } catch (err) {
    // Redis unavailable — fail closed. Lua is atomic so either escrow ran fully or not at all.
    redisErrorRejections.inc();
    log.error('Redis error during bet setup — rejecting bet (fail closed)', {
      event: 'REDIS_UNAVAILABLE',
      userId: pseudonymize(userId),
      error: String(err),
      stack: (err as Error).stack,
    });
    security.warn('Bet rejected due to Redis unavailability', { event: 'REDIS_UNAVAILABLE', userId: pseudonymize(userId), path: 'escrow' });
    sendError(ws, WebSocketErrorCode.INTERNAL_ERROR, 'Service temporarily unavailable');
    return;
  }
  redisLuaDuration.observe(performance.now() - luaStart);

  if (!serverSeed) {
    // Seed missing — release escrow if it was taken before returning error.
    if (escrowResult.success) {
      releaseEscrowWithRetry(userId, chain, currency, wagerAmount.toFixed(8)).catch(() => {});
    }
    sendError(ws, WebSocketErrorCode.INTERNAL_ERROR, 'Server seed not found');
    return;
  }

  if (!escrowResult.success) {
    doubleSpendRejections.inc();
    security.warn('Double-spend rejected', { event: 'DOUBLE_SPEND_REJECTED', userId: pseudonymize(userId), wager: wagerAmount, balance: escrowResult.newBalance, chain, currency });
    sendError(ws, WebSocketErrorCode.INSUFFICIENT_BALANCE, 'Balance too low for this wager');
    return;
  }

  wagerVolumeTotal.inc({ chain, currency }, wagerAmount);

  const nonce = escrowResult.nonce;
  const pfStart = performance.now();
  let pfResult: { gameResult: number; gameHash: string };
  try {
    pfResult = await pfCalculate(clientSeed, nonce, serverSeed);
  } catch (err) {
    // PF worker failed — release the escrowed wager back to available balance.
    log.error('PF calculate error', { event: 'WS_MESSAGE_ERROR', userId: pseudonymize(userId), error: String(err), stack: (err as Error).stack });
    releaseEscrowWithRetry(userId, chain, currency, wagerAmount.toFixed(8)).catch(() => {});
    sendError(ws, WebSocketErrorCode.INTERNAL_ERROR, 'Game computation failed');
    return;
  }
  pfHashDuration.observe(performance.now() - pfStart);
  const { gameResult, gameHash } = pfResult;

  const isWin =
    (direction === 'under' && gameResult < target) ||
    (direction === 'over' && gameResult > target);

  const winChance = direction === 'under' ? target - 1 : 100 - target;
  const multiplier = winChance > 0 ? (100 - config.houseEdgePct) / winChance : 0;
  const payoutAmount = isWin ? wagerAmount * multiplier : 0;

  // C3/H6 — Optimistic balance: post-escrow available balance.
  // settleBetAsync and Kafka publish are fire-and-forget to keep response latency minimal.
  // Frontend adds payoutAmount on win (Bug Fix #3) → displays correct post-settle balance.
  const optimisticBalance = escrowResult.newBalance;
  const betId = uuidv4();
  const durationMs = Math.round(performance.now() - betStart);
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

  // C3/H6 — Settle escrow fire-and-forget (runs for both wins and losses).
  // settleBetAsync releases wager from escrowed and credits payout (0 on loss).
  // Retries up to 3× on transient Redis errors — no bet should strand funds in escrow.
  settleBetAsync(userId, chain, currency, wagerAmount.toFixed(8), payoutAmount.toFixed(8)).catch(() => {});

  produceBetResolved(event).catch((err) =>
    log.error('BetResolved produce error', { event: 'KAFKA_PRODUCE_ERROR', betId, userId: pseudonymize(userId), error: String(err) }),
  );

  betsTotal.inc({ outcome: isWin ? 'win' : 'loss', chain, currency });
  betProcessingDuration.observe(performance.now() - betStart);

  audit.info('Bet resolved', {
    event: 'BET_RESOLVED',
    userId: pseudonymize(userId),
    betId,
    wager: wagerAmount,
    payout: payoutAmount,
    result: gameResult,
    chain,
    currency,
    outcome: isWin ? 'WIN' : 'LOSS',
    durationMs,
  });

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
  // Subscribe (or re-subscribe on reconnect) whenever the connection is ready.
  function doSubscribe() {
    redisSub.psubscribe('user:updates:*', (err) => {
      if (err) log.error('Pub/Sub subscribe error', { event: 'WS_MESSAGE_ERROR', error: String(err) });
      else log.info('Subscribed to Redis pub/sub', { event: 'REDIS_PUBSUB_SUBSCRIBED', channel: 'user:updates:*' });
    });
  }
  redisSub.on('ready', doSubscribe);
  // Also subscribe immediately if the connection is already ready (likely on first call).
  if (redisSub.status === 'ready') doSubscribe();

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
