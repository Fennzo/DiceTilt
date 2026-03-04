---
name: security
description: Security standards for DiceTilt. Apply automatically when writing or reviewing any code in this project.
user-invocable: false
---

Apply these security standards whenever writing or reviewing code for this project.

## Input Validation

- All API boundaries use **Zod schemas** from `@dicetilt/shared-types`
- Never trust client-supplied data without parsing through a schema first
- Return `400 INVALID_PAYLOAD` with `parsed.error.issues` on validation failure

## Authentication & Authorization

- Always verify JWT tokens using `config.jwtSecret` — never a hardcoded string
- After JWT verification, **check session validity** via `checkSession(userId)` in Redis before processing
- Return `401 SESSION_REVOKED` if the session is gone
- Log session revocations to the `security` logger: `security.warn(..., { event: 'SESSION_REVOKED', userId: pseudonymize(userId) })` — use `pseudonymize` from `@dicetilt/logger`; see Logging Security Events

## SQL Safety

- Always use **parameterized queries** (`$1, $2, ...`) with the `pg` client
- Never concatenate user input into SQL strings
- Use `ON CONFLICT DO NOTHING` for idempotent inserts

## Rate Limiting

- Use `checkRateLimit(userId, action, windowSeconds, limit)` from `redis.service.ts` for any user-initiated high-frequency action
- Log rejections with the `security` logger and increment `dicetilt_rate_limit_rejections_total`
- **Fail-over strategy (no unconditional fail-open):** Use a circuit-breaker pattern that switches to degraded mode when Redis is down. Degraded mode uses configurable fallback limits (default: more restrictive / lower rate limits) enforced by a local in-memory limiter for critical endpoints. Do not allow unbounded traffic on Redis failure — gambling flows require enforcement. The default is to be more restrictive, not permissive; fallback thresholds are configurable (e.g. via env vars).
- On failed Redis checks: log with the `security` logger, increment `dicetilt_rate_limit_redis_errors_total` (not `dicetilt_rate_limit_rejections_total` — that is for user rate-limit violations only). Emit an alert (e.g. Prometheus alert on `redisErrorRejections`).
- Document acceptable Redis downtime and review the fail-over strategy with Security and Ops teams.

## Secrets & Configuration

- Never hardcode credentials, keys, RPC URLs, or contract addresses
- All secrets must come from environment variables via `config.ts`

## Cryptographic Operations

- Use Node's built-in `crypto` module for hashing
- Never implement custom cryptographic primitives
- All game outcomes must remain verifiable via the provably-fair system: client seed + server seed + nonce → deterministic hash → outcome

## Logging Security Events

- Use `security.warn()` for suspicious but non-fatal events (bad tokens, revoked sessions, rate-limit hits)
- Use `audit.info()` for security-relevant business events (withdrawals, deposits, bet settlements)
- **Pseudonymize user identifiers:** Do not log raw `userId` in `{ event: 'EVENT_CODE', userId }` payloads. Use the centralized `pseudonymize(userId)` from `@dicetilt/logger` — it uses HMAC-SHA256 with `PSEUDONYM_SECRET` (env) and versioned key `PSEUDONYM_KEY_VERSION` (env, default `'1'`). Non-reversible, no plaintext storage. Replace `userId` with `pseudonymize(userId)` in all `security.warn()` and `audit.info()` calls. **Implementation:** `packages/logger/src/pseudonymize.ts`; **Config:** `config.ts` (`pseudonymSecret`, `pseudonymKeyVersion`), `.env.example` (`PSEUDONYM_SECRET`, `PSEUDONYM_KEY_VERSION`). **Key management:** Store `PSEUDONYM_SECRET` in a secrets manager; rotate by incrementing `PSEUDONYM_KEY_VERSION` (new version = new hashes; old logs retain old pseudonyms). **Tests:** `tests/unit/pseudonymize.spec.ts`.
- **Config flags:** Make inclusion of identifiers conditional via `LOG_RETENTION_MODE` and `AUDIT_MODE`. Implement in `config.ts` as exported constants read from `process.env`. Set via env vars `LOG_RETENTION_MODE` and `AUDIT_MODE`. Defaults: `LOG_RETENTION_MODE='hashed'`, `AUDIT_MODE='standard'`.
  - **LOG_RETENTION_MODE** (`'full' | 'hashed' | 'minimal'`): `full` = store reversible tokens/identifiers for compliance queries; `hashed` = store non-reversible hashes (default); `minimal` = drop identifiers from logs.
  - **AUDIT_MODE** (`'off' | 'standard' | 'compliant'`): `off` = no audit metadata; `standard` = include pseudonymized identifiers (default); `compliant` = force full reversible tokens and extra retention logging for regulatory audits.
- **Retention & deletion:** Define log retention periods and deletion policies (e.g. 90 days for security logs, 7 years for audit). Document in ops runbooks.
- **Right-to-erasure:** When handling erasure requests, remove or rotate identifiers in logs. The **token manager** is the component/service that issues pseudonyms and (if reversible) resolves them back to identifiers. Choose one approach:
  - **(1) One-way pseudonymization (HMAC):** Re-keying is not possible — HMAC output cannot be reversed. For erasure: purge or redact logs containing the pseudonyms; delete any source mapping (e.g. lookup table) if present; or use per-request salts to achieve controlled unlinkability (each pseudonym is unique and cannot be linked across requests).
  - **(2) Reversible encryption:** Key-rotation and revocation procedure: (a) generate a new encryption key; (b) re-encrypt active tokens with the new key; (c) securely delete or rotate old keys from the key store; (d) mark old keys as revoked so prior pseudonyms can no longer be resolved. For logs: implement an automatic log retention policy, secure deletion pipeline, and redaction pipeline — purge or redact logs containing identifiers before retention expiry; document the procedure in ops runbooks.

## WebSocket Security

- WS auth must use first-frame `{ type: 'AUTH', token }` pattern — never URL query params
- Enforce 10-second auth timeout on unauthenticated connections
- Cap connections per user at `MAX_CONNECTIONS_PER_USER = 5`
- Set `maxPayload: 64 * 1024` to prevent oversized frame attacks

## Financial Safety

- All balance mutations must go through **Lua scripts** in `redis.service.ts` (atomic compare-and-set)
- Never read balance then write balance in two separate Redis commands
- On Kafka publish failure after balance deduction: always credit back atomically and log as `KAFKA_PRODUCE_ERROR`
