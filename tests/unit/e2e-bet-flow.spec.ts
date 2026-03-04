import { ethers } from 'ethers';
import WebSocket from 'ws';
import Redis from 'ioredis';

const API_URL = 'http://localhost:3000';
const WS_URL = 'ws://localhost:3000/ws';
const REDIS_URL = process.env['REDIS_URI'] ?? 'redis://localhost:6380';

async function authenticate(): Promise<{ token: string; userId: string }> {
  const res = await fetch(`${API_URL}/api/v1/dev/token?walletIndex=399`);
  const { token } = await res.json() as { token: string };
  const decoded = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
  return { token, userId: decoded.userId };
}

function connectWs(token: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WS connect timeout')), 10000);
    const ws = new WebSocket(WS_URL);
    ws.on('error', (err) => { clearTimeout(timer); reject(err); });
    ws.once('open', () => {
      ws.send(JSON.stringify({ type: 'AUTH', token }));
    });
    ws.on('message', function authHandler(data: WebSocket.Data) {
      try {
        const msg = JSON.parse(data.toString()) as { type: string; code?: string };
        if (msg.type === 'AUTH_OK') {
          clearTimeout(timer);
          ws.removeListener('message', authHandler);
          resolve(ws);
        } else if (msg.type === 'ERROR') {
          clearTimeout(timer);
          ws.removeListener('message', authHandler);
          reject(new Error(`AUTH rejected: ${msg.code}`));
        }
      } catch { /* skip non-JSON */ }
    });
  });
}

function sendAndReceive(ws: WebSocket, msg: object): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const handler = (data: WebSocket.Data) => {
      ws.off('message', handler);
      resolve(JSON.parse(data.toString()));
    };
    ws.on('message', handler);
    ws.send(JSON.stringify(msg));
    setTimeout(() => { ws.off('message', handler); reject(new Error('Response timeout')); }, 5000);
  });
}

describe('End-to-End Bet Flow (live Docker stack)', () => {
  let token: string;
  let userId: string;
  let ws: WebSocket;
  let redis: Redis;

  beforeAll(async () => {
    const auth = await authenticate();
    token = auth.token;
    userId = auth.userId;
    ws = await connectWs(token);
    redis = new Redis(REDIS_URL);
  }, 15000);

  afterAll(async () => {
    ws?.close();
    await redis?.quit();
  });

  test('PING/PONG works', async () => {
    const res = await sendAndReceive(ws, { type: 'PING' });
    expect(res.type).toBe('PONG');
  });

  test('BET_REQUEST returns BET_RESULT with correct fields', async () => {
    const res = await sendAndReceive(ws, {
      type: 'BET_REQUEST',
      wagerAmount: 1,
      clientSeed: 'test-e2e-seed',
      chain: 'ethereum',
      currency: 'ETH',
      target: 50,
      direction: 'under',
    });

    expect(res.type).toBe('BET_RESULT');
    expect(res.gameResult).toBeGreaterThanOrEqual(1);
    expect(res.gameResult).toBeLessThanOrEqual(100);
    expect(res.gameHash).toBeDefined();
    expect(res.nonce).toBe(1);
    expect(res.target).toBe(50);
    expect(res.direction).toBe('under');
    expect(typeof res.multiplier).toBe('number');
    expect(typeof res.newBalance).toBe('number');
  });

  test('3 bets result in nonce 3 in Redis', async () => {
    for (let i = 0; i < 2; i++) {
      await sendAndReceive(ws, {
        type: 'BET_REQUEST',
        wagerAmount: 0.1,
        clientSeed: 'nonce-test',
        chain: 'ethereum',
        currency: 'ETH',
        target: 50,
        direction: 'under',
      });
    }

    const nonce = await redis.get(`user:${userId}:nonce:ethereum:ETH`);
    expect(parseInt(nonce!, 10)).toBe(3);
  });

  test('insufficient balance returns INSUFFICIENT_BALANCE error', async () => {
    const res = await sendAndReceive(ws, {
      type: 'BET_REQUEST',
      wagerAmount: 11,
      clientSeed: 'overdraft-test',
      chain: 'ethereum',
      currency: 'ETH',
      target: 50,
      direction: 'under',
    });

    expect(res.type).toBe('ERROR');
    expect(res.code).toBe('INSUFFICIENT_BALANCE');
  });

  test('Redis Pub/Sub push reaches WebSocket client', async () => {
    const pubRedis = new Redis(REDIS_URL);
    const channel = `user:updates:${userId}`;
    const payload = JSON.stringify({
      type: 'BALANCE_UPDATE',
      balance: 99.99,
      chain: 'ethereum',
      currency: 'ETH',
    });

    const received = new Promise<Record<string, unknown>>((resolve, reject) => {
      const handler = (data: WebSocket.Data) => {
        ws.off('message', handler);
        resolve(JSON.parse(data.toString()));
      };
      ws.on('message', handler);
      setTimeout(() => { ws.off('message', handler); reject(new Error('Pub/Sub timeout')); }, 5000);
    });

    await pubRedis.publish(channel, payload);
    const msg = await received;

    expect(msg.type).toBe('BALANCE_UPDATE');
    expect(msg.balance).toBe(99.99);

    await pubRedis.quit();
  });
});
