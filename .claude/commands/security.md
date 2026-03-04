# security

Apply these security standards whenever writing or reviewing code for this project.

## Input Validation

- All API boundaries use **Zod schemas** from `@dicetilt/shared-types` (e.g. `WithdrawRequestSchema`, `BetRequestSchema`)
- Never trust client-supplied data without parsing through a schema first
- Return `400 INVALID_PAYLOAD` with `parsed.error.issues` on validation failure

## Authentication & Authorization

- Always verify JWT tokens using `config.jwtSecret` — never a hardcoded string
- After JWT verification, **check session validity** via `checkSession(userId)` in Redis before processing
- Return `401 SESSION_REVOKED` if the session is gone
- Log session revocations to the `security` logger: `security.warn(..., { event: 'SESSION_REVOKED', userId })`

## SQL Safety

- Always use **parameterized queries** (`$1, $2, ...`) with the `pg` client
- Never concatenate user input into SQL strings
- Use `ON CONFLICT DO NOTHING` for idempotent inserts to avoid duplicate processing errors

## Rate Limiting

- Use `checkRateLimit(userId, action, windowSeconds, limit)` from `redis.service.ts` for any user-initiated high-frequency action
- Log rejections with the `security` logger and increment `dicetilt_rate_limit_rejections_total`
- **Critical vs low-risk:** Critical endpoints (withdrawals, bets, account changes) must **fail closed** on Redis/ratelimiter failures — deny the request with `INTERNAL_ERROR` rather than bypass enforcement. Low-risk endpoints (profile reads, public data) may fail open. *Rationale:* Gambling and financial flows require rate-limit enforcement; transient Redis blips must not allow unbounded traffic on critical paths.
- **Examples:** `POST /api/v1/withdraw` → fail closed; `WS BET_REQUEST` → fail closed; `GET /api/v1/balance` → may fail open. Critical-path failures must deny requests, not bypass rate limits.

## Secrets & Configuration

- Never hardcode credentials, keys, RPC URLs, or contract addresses
- All secrets must come from environment variables via `config.ts`
- Use `config.jwtSecret`, `config.privateKey`, `config.redisUri`, etc.

## Cryptographic Operations

- Use Node's built-in `crypto` module for hashing (HMAC-SHA256 for provably fair)
- Never implement custom cryptographic primitives
- All game outcomes must remain verifiable via the provably-fair system: client seed + server seed + nonce → deterministic hash → outcome

## Logging Security Events

- Use `security.warn()` for suspicious but non-fatal events (bad tokens, revoked sessions, rate-limit hits)
- Use `audit.info()` for security-relevant business events (withdrawals, deposits, bet settlements)
- Use `app.error()` for operational failures
- Always include `{ event: 'EVENT_CODE', userId }` so logs are queryable
- **Redact sensitive data before logging:** Never log raw tokens, session IDs, passwords/hashes, payment card numbers, or PII (emails, SSNs, addresses). Use a central redaction helper (e.g. `redactSensitive` or logger serializers) to standardize masking of fields like `token`, `sessionId`, `password`, `cardNumber`, `email`, `ssn` before emitting logs. Applies to all logger calls (`security.warn`, `audit.info`, `app.error`).
- Security events go to `security` logger only — not `console.log`

## WebSocket Security

- WS auth must use first-frame `{ type: 'AUTH', token }` pattern — never URL query params
- Enforce 10-second auth timeout on unauthenticated connections
- Cap connections per user at `MAX_CONNECTIONS_PER_USER = 5`
- Set `maxPayload: 64 * 1024` to prevent oversized frame attacks

## Financial Safety

- All balance mutations must go through **Lua scripts** in `redis.service.ts` (atomic compare-and-set)
- Never read balance then write balance in two separate Redis commands
- On Kafka publish failure after balance deduction: always credit back atomically and log as `KAFKA_PRODUCE_ERROR`
