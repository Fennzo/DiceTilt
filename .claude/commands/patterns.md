# patterns

Maintain these project conventions whenever writing code for DiceTilt. These are the "vibe" of this codebase — match them exactly.

## TypeScript

- **Strict mode is on**: no implicit `any`, no untyped catch variables (use `(e: unknown)`)
- Use named exports everywhere (`export function foo`, `export { router as fooRouter }`)
- Define interfaces near the code that uses them (not in separate `types.ts` files unless they're shared)
- Use `as` casts only when unavoidable; prefer type guards
- Prefer `readonly` arrays/properties where mutation is not needed

## Service Structure

Every service follows this layout:
```
services/<name>/
  src/
    index.ts      — main entry, startup, graceful shutdown
    config.ts     — all env vars with defaults, export const config = { ... }
    *.routes.ts   — Express routers (api-gateway only)
    *.ts          — other modules
  package.json
  tsconfig.json
  Dockerfile
```

- Config always lives in `config.ts` — read `process.env['VAR_NAME'] ?? 'default'`
- No magic numbers or strings in business logic — put them in `config.ts`

## Logging

Use `createLoggers(serviceName)` from `@dicetilt/logger`:

```typescript
const { app: log, audit, security } = createLoggers('service-name');
```

- `app` / `log` — operational events (startup, connections, errors)
- `audit` — security-relevant business events (bets settled, deposits, withdrawals)
- `security` — threats and suspicious activity (bad tokens, rate-limit hits, session revocations)

Every log call must include `{ event: 'SCREAMING_SNAKE_CASE_CODE' }`:
```typescript
log.info('Message here', { event: 'SERVICE_STARTED', port: config.port });
audit.info('Bet settled', { event: 'BET_SETTLED', betId, userId });
security.warn('JWT error', { event: 'JWT_ERROR', path, error: String(err) });
```

## HTTP Response Format

```typescript
res.status(400).json({ error: 'ERROR_CODE' });                         // client error
res.status(400).json({ error: 'ERROR_CODE', details: zodIssues });     // validation failure
res.status(202).json({ withdrawalId, status: 'PENDING' });             // accepted
res.status(500).json({ error: 'INTERNAL_ERROR' });                     // server error
```

Error codes are SCREAMING_SNAKE_CASE strings, never numeric codes.

## Redis Key Schema

```
user:{userId}:balance:{chain}:{currency}   — available balance (string float)
user:{userId}:escrowed:{chain}:{currency}  — in-play wager held
user:{userId}:nonce:{chain}:{currency}     — provably-fair nonce
user:{userId}:serverSeed                   — server seed for current session
session:{userId}                           — 'active' string with TTL
ratelimit:{userId}:{action}               — ZSET for sliding-window rate limit
```

Never add new key patterns without updating this schema.

## Lua Scripts in Redis

- All atomic balance mutations use Lua scripts (no two-step read-then-write)
- Scripts live as `const FOO_LUA = \`...\`` constants at the top of `redis.service.ts`
- Each script is wrapped in a typed async function with descriptive JSDoc comment

## Kafka

- Topic names come from `KAFKA_TOPICS` in `@dicetilt/shared-types` — never hardcoded strings
- Event types come from the typed interfaces (`BetResolvedEvent`, `DepositReceivedEvent`, etc.)
- Producers use `{ idempotent: true }` where possible
- Consumers use `eachBatch` + `autoCommit: true` for bulk topics (BetResolved), `eachMessage` for rare topics (deposits, withdrawals)
- Inserts are idempotent: `ON CONFLICT DO NOTHING` so Kafka at-least-once redelivery is safe

## Error Handling

```typescript
try {
  // ...
} catch (err) {
  if (err instanceof SpecificError) {
    log.warn('...', { event: 'SPECIFIC_ERROR', error: String(err) });
    res.status(4xx).json({ error: 'CODE' });
    return;
  }
  log.error('...', { event: 'GENERAL_ERROR', error: String(err), stack: (err as Error).stack });
  res.status(500).json({ error: 'INTERNAL_ERROR' });
}
```

- Always return after sending a response
- Log `stack` on unexpected errors, not on expected ones (bad JWT, insufficient balance)

## Graceful Shutdown

Every `index.ts` main() must handle `SIGTERM`:
```typescript
process.on('SIGTERM', async () => {
  await consumer.disconnect();
  await pool.end();
  await redis.quit();
  process.exit(0);
});
```

## Metrics (Prometheus)

- Counter/Gauge names follow `dicetilt_<noun>_<verb>_total` pattern
- Always include `labelNames` for dimensions (e.g. `['chain']`, `['limiter_type']`)
- Increment counters in the success path, not the error path (unless it's an error counter)
- Metrics endpoint: `GET /metrics` on a dedicated port (not the main API port)

## Shared Types

- All Kafka event shapes live in `packages/shared-types/src/index.ts`
- All Zod schemas live in `packages/shared-types/src/validation.ts`
- All WebSocket message types live in `packages/shared-types/src/websocket.ts`
- When adding a new Kafka event, add both the TypeScript interface AND the `KAFKA_TOPICS` entry
