---
name: patterns
description: DiceTilt project conventions and code patterns. Apply automatically when writing or reviewing code to maintain consistency.
user-invocable: false
---

Maintain these project conventions whenever writing code for DiceTilt.

## TypeScript

- **Strict mode is on**: no implicit `any`, no untyped catch variables (use `(e: unknown)`)
- Use named exports everywhere (`export function foo`, `export { router as fooRouter }`)
- Define interfaces near the code that uses them (not in separate `types.ts` unless shared)
- Use `as` casts only when unavoidable; prefer type guards
- Prefer `readonly` where mutation is not needed

## Service Structure

Every service follows this layout:
```
services/<name>/
  src/
    index.ts      — main entry, startup, graceful shutdown
    config.ts     — all env vars with defaults
    *.routes.ts   — Express routers (api-gateway only)
  package.json
  tsconfig.json
  Dockerfile
```

Config always lives in `config.ts` — read `process.env['VAR_NAME'] ?? 'default'`. No magic numbers in business logic.

## Logging

Use `createLoggers(serviceName)` from `@dicetilt/logger`:

```typescript
const { app: log, audit, security } = createLoggers('service-name');
```

- `log` — operational events (startup, connections, errors)
- `audit` — security-relevant business events (bets settled, deposits, withdrawals)
- `security` — threats and suspicious activity

Every log call must include `{ event: 'SCREAMING_SNAKE_CASE_CODE' }`:
```typescript
log.info('Message', { event: 'SERVICE_STARTED', port: config.port });
audit.info('Bet settled', { event: 'BET_SETTLED', betId, userId });
security.warn('JWT error', { event: 'JWT_ERROR', error: String(err) });
```

## HTTP Response Format

```typescript
res.status(400).json({ error: 'ERROR_CODE' });
res.status(400).json({ error: 'ERROR_CODE', details: zodIssues });
res.status(202).json({ withdrawalId, status: 'PENDING' });
res.status(500).json({ error: 'INTERNAL_ERROR' });
```

Error codes are SCREAMING_SNAKE_CASE strings. Always `return` after sending a response.

## Redis Key Schema

```
user:{userId}:balance:{chain}:{currency}   — available balance
user:{userId}:escrowed:{chain}:{currency}  — in-play wager held
user:{userId}:nonce:{chain}:{currency}     — provably-fair nonce
user:{userId}:serverSeed                   — server seed for session
session:{userId}                           — 'active' with TTL
ratelimit:{userId}:{action}               — ZSET sliding-window rate limit
```

All atomic balance mutations use Lua scripts — no two-step read-then-write.

## Kafka

- Topic names come from `KAFKA_TOPICS` in `@dicetilt/shared-types` — never hardcoded strings
- Event types come from typed interfaces (`BetResolvedEvent`, `DepositReceivedEvent`, etc.)
- Producers use `{ idempotent: true }` where possible
- `eachBatch` + `autoCommit: true` for bulk topics (BetResolved); `eachMessage` for rare topics
- Inserts are idempotent: `ON CONFLICT DO NOTHING`

## Error Handling

```typescript
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

Log `stack` only on unexpected errors. Never on expected ones (bad JWT, insufficient balance).

## Graceful Shutdown

Every `index.ts` must handle `SIGTERM`:
```typescript
process.on('SIGTERM', async () => {
  await consumer.disconnect();
  await pool.end();
  await redis.quit();
  process.exit(0);
});
```

## Metrics

- Counter names: `dicetilt_<noun>_<verb>_total`
- Always include `labelNames` for dimensions (e.g. `['chain']`)
- Metrics on dedicated port, separate from API port

## Maintainability

- **Single responsibility**: each function does one thing; if it needs a comment to explain what it does, it should be a named function
- **Config over magic values**: every timeout, limit, threshold, and URL lives in `config.ts` — never inline constants in business logic
- **No premature abstraction**: don't create helpers for one-off operations; three similar lines of code is better than a wrapper used once
- **No speculative features**: don't design for hypothetical future requirements; build exactly what is needed now
- **Avoid backwards-compat shims**: if something is unused, delete it — don't rename to `_unused` or add `// removed` comments
- **Keep modules small**: if a file grows beyond ~300 lines, consider splitting by responsibility
- **Explicit over clever**: prefer readable code over terse one-liners; future-you will thank present-you

## Scalability

- **Connection pools**: always use `pg.Pool` — never a single `pg.Client` for request handling; pool config lives in `config.ts`
- **Redis pipelines**: use `redis.pipeline()` for multi-key writes (e.g. `initUserRedisState`) — one round-trip, not N
- **Lua scripts for hot paths**: atomic Redis operations via Lua avoid TOCTOU races and cut round-trips on every bet
- **Kafka batching**: `eachBatch` on BetResolved with configurable `BATCH_SIZE` — one `INSERT ... VALUES ($1,...),($N,...)` per batch, not one query per message
- **Piscina thread pool**: pre-warm all threads at startup (`minThreads = maxThreads = max(2, cpuCount)`) — lazy spawn adds 50-200ms per thread under load
- **Cluster mode**: api-gateway forks `CLUSTER_WORKERS` processes (default: cpuCount); aggregated metrics on port 9091 via `AggregatorRegistry`
- **Heartbeats in long batches**: call `await heartbeat()` between batch chunks in Kafka consumers to prevent session timeout on slow DB writes
- **Avoid blocking the event loop**: CPU-bound work (hash computation) goes to Piscina workers, never inline in a request handler

## Shared Types

- Kafka event shapes → `packages/shared-types/src/index.ts`
- Zod schemas → `packages/shared-types/src/validation.ts`
- WebSocket message types → `packages/shared-types/src/websocket.ts`
