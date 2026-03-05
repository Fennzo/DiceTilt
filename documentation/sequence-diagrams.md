# DiceTilt — Sequence Diagrams

**Audience:** Software architects, senior engineers.

All user-facing and session-related interaction flows. For blockchain-specific deposit and withdrawal flows, see `blockchain-flows.md`. For infrastructure and operational flows, see `infrastructure-flows.md`.

---

## Flow Index

| # | Flow | Category |
|---|---|---|
| 1 | Burner Wallet Creation + EIP-712 Authentication | Auth |
| 2 | WebSocket Connection Upgrade | Auth |
| 3 | User Logout (Explicit Session Invalidation) | Auth |
| 4 | Session Expiry (TTL-based Automatic Invalidation) | Auth |
| 5 | Session Revocation (Admin-Initiated) | Auth |
| 6 | Bet — WIN Path (Full end-to-end) | Game Loop |
| 7 | Bet — LOSS Path | Game Loop |
| 8 | Bet — Insufficient Balance (Lua Rejection) | Game Loop |
| 9 | Bet — Rate Limited (Sliding Window Triggered) | Game Loop |
| 10 | Bet — Invalid Payload (Zod Rejection) | Game Loop |
| 11 | Bet Amount Adjustment (Client-Side Only) | Game Loop |
| 12 | Provably Fair — Status Check | Provably Fair |
| 13 | Provably Fair — Seed Rotation + Client Verification | Provably Fair |
| 14 | Caching — Balance Cache MISS (Hydration from Postgres) | Caching |
| 15 | Caching — Balance Cache HIT (Normal Path) | Caching |
| 16 | Caching — Balance Eviction Recovery | Caching |
| 17 | WebSocket PING / PONG Keep-Alive | Infrastructure |
| 18 | WebSocket Connection State Machine | Infrastructure |
| 19 | Developer & Testing Infrastructure (TEST_MODE + /?demo=1) | Developer Tools |

---

## Flow 1 — Burner Wallet Creation + EIP-712 Authentication

No MetaMask required. The client generates a local burner wallet on page load and uses it to sign the EIP-712 challenge.

```mermaid
sequenceDiagram
    participant B as Browser (index.html)
    participant N as Nginx
    participant API as API Gateway
    participant Redis as Redis
    participant PF as PF Worker

    Note over B: Page load — no extension required
    B->>B: ethers.Wallet.createRandom() → burnerWallet (stored in memory only)

    B->>N: POST /api/v1/auth/challenge
    N->>API: forward
    API->>API: generate cryptographically random nonce (uuid v4)
    API-->>N: { nonce: 'a3f8...' }
    N-->>B: { nonce: 'a3f8...' }

    B->>B: burnerWallet.signMessage(EIP-712 typed data including nonce)
    Note over B: Signature proves wallet ownership without any transaction

    B->>N: POST /api/v1/auth/verify { walletAddress, signature }
    N->>API: forward
    API->>API: ethers.utils.verifyMessage(signature) → recoveredAddress
    API->>API: assert recoveredAddress === walletAddress

    alt Signature valid
        API->>PF: POST /api/pf/generate-seed (internal, auth token required)
        PF->>PF: crypto.randomBytes(32).toString('hex') → serverSeed
        PF-->>API: { serverSeed }

        API->>API: INSERT INTO users (id, active_server_seed)
        API->>API: INSERT INTO wallets (user_id, ethereum, ETH, balance=10, wallet_address) — default PoC balance, wallet_address from signed payload
        API->>API: INSERT INTO wallets (user_id, solana, SOL, balance=10, wallet_address) — both chains, Solana address placeholder until user connects Solana keypair
        API->>Redis: SET session:{userId} 'active' EX 86400
        API->>Redis: SET user:{userId}:nonce:ethereum:ETH '0' (and solana:SOL) — nonce lives in Redis
        API->>Redis: SET user:{userId}:balance:ethereum:ETH '10' (and solana:SOL) — default balance
        API->>API: jwt.sign({ userId, walletAddress }) → JWT

        API-->>B: { token: 'eyJ...' }
        Note over B: Store JWT in memory (not localStorage — XSS risk)
    else Signature invalid
        API-->>B: HTTP 401 { error: 'INVALID_SIGNATURE' }
    end
```

---

## Flow 2 — WebSocket Connection Upgrade

After obtaining a JWT, the client upgrades to a persistent WebSocket connection. The JWT is **never** placed in the URL or HTTP headers — it is sent as the first WebSocket frame after the connection is established, preventing the token from appearing in Nginx access logs or browser history.

```mermaid
sequenceDiagram
    participant B as Browser
    participant N as Nginx
    participant API as API Gateway
    participant Redis as Redis

    B->>N: GET /ws  Upgrade: websocket  (no JWT — bare HTTP upgrade)
    Note over N: nginx.conf passes Upgrade + Connection headers (Constraint 13)
    N->>API: forward WebSocket upgrade request
    API-->>B: HTTP 101 Switching Protocols — raw socket established

    Note over API: 10-second auth timeout — no PONG/other frames until AUTH_OK, timeout → close(1008) + dicetilt_auth_failures_total
    Note over API: maxPayload = 64 KB (cap incoming frame size — default 100 MB is unsafe)

    B->>API: WS send → { type: 'AUTH', token: 'eyJ...' }  ← first frame (must arrive within 10s)
    API->>API: AuthMessageSchema.parse(frame) — validate shape
    API->>API: jwt.verify(token) → { userId, walletAddress }

    alt First frame is not AUTH (e.g. BET_REQUEST, PING), or JWT expired / malformed
        Note over API: Increment dicetilt_auth_failures_total
        API-->>B: ws.close(1008, 'first frame must be AUTH' | 'invalid token')
        Note over B: Connection closed — client must re-obtain a JWT and retry
    else JWT valid
        API->>Redis: GET session:{userId}

        alt Session revoked (key missing or expired)
            Note over API: Increment dicetilt_auth_failures_total
            API->>B: WS push → { type: 'SESSION_REVOKED' }
            API->>API: ws.close()
        else Session active ('active' value returned)
            Note over API: Enforce per-user connection cap (MAX_CONNECTIONS_PER_USER = 5)
            alt User already has 5 open sockets
                Note over API: Increment dicetilt_auth_failures_total
                API-->>B: ws.close(1008, 'connection limit reached')
            else Under limit
                API->>API: register WebSocket in memory map (userId → Set<WebSocket>)
                API->>B: WS push → { type: 'AUTH_OK' }
                Note over B, API: Persistent bi-directional connection fully active
            end
        end
    end
```

---

## Flow 3 — User Logout (Explicit Session Invalidation)

```mermaid
sequenceDiagram
    participant B as Browser
    participant N as Nginx
    participant API as API Gateway
    participant Redis as Redis

    B->>N: POST /api/v1/auth/logout  Authorization: Bearer {JWT}
    N->>API: forward
    API->>API: jwt.verify(token) → { userId }
    API->>Redis: DEL session:{userId}
    Redis-->>API: (integer) 1

    API->>API: close open WebSocket connection for userId (if any)
    Note over API: WS close frame sent before server-side socket destruction
    API-->>B: HTTP 200 { message: "logged out" }

    Note over B: Client discards JWT from memory. WS connection already closed.
```

---

## Flow 4 — Session Expiry (TTL-Based Automatic Invalidation)

```mermaid
sequenceDiagram
    participant B as Browser
    participant N as Nginx
    participant API as API Gateway
    participant Redis as Redis

    Note over Redis: session:{userId} TTL reaches 0 — key deleted automatically

    B->>N: POST /api/v1/withdraw  Authorization: Bearer {JWT}
    N->>API: forward
    API->>API: jwt.verify(token) → still valid (JWT has not expired yet)
    API->>Redis: GET session:{userId}
    Redis-->>API: (nil) — key expired

    API-->>B: HTTP 401 { code: "SESSION_EXPIRED" }
    Note over B: Client must re-authenticate via EIP-712 to continue
```

---

## Flow 5 — Session Revocation (Admin-Initiated)

```mermaid
sequenceDiagram
    participant Admin as Admin Process
    participant Redis as Redis
    participant API as API Gateway
    participant B as Browser (active WS)

    Admin->>Redis: DEL session:{userId}
    Redis-->>Admin: (integer) 1

    Note over API: API Gateway polls or subscribes to Redis keyspace events for session deletions
    API->>API: detect session:{userId} deleted
    API->>B: WS push → { type: "SESSION_REVOKED" }

    Note over B: Client receives SESSION_REVOKED message
    B->>B: close WS, clear JWT from memory, redirect to login
```

---

## Flow 6 — Bet, WIN Path (Full End-to-End)

The complete betting loop showing synchronous resolution (<20ms) and asynchronous ACID settlement.

```mermaid
sequenceDiagram
    participant B as Browser
    participant N as Nginx
    participant API as API Gateway
    participant Redis as Redis
    participant PF as PF Worker
    participant Kafka as Kafka
    participant LC as Ledger Consumer
    participant PG as PostgreSQL

    B->>N: WS send → { type: 'BET_REQUEST', wagerAmount: 10, clientSeed: 'abc123', chain: 'ethereum', currency: 'ETH', target: 50, direction: 'under' }
    N->>API: route WebSocket frame

    API->>API: Zod.parse(frame) — validate all fields (wagerAmount > 0, target 2–98, direction, chain, currency, clientSeed ≤ 64 chars)
    API->>API: check Redis session:{userId} still active

    par Atomic balance deduct
        API->>Redis: EVAL lua_balance_check_deduct(userId, 'ethereum', 'ETH', 10)
        Note over Redis: Atomic: GET balance, assert >= wager, SET balance - wager, INCR nonce, return newBalance + nonce
        Redis-->>API: { success: true, newBalance: 90, nonce: 42 }
    and Fetch server seed
        API->>API: getServerSeed(userId) — read from Redis (fallback: Postgres wallets.active_server_seed)
    end
    Note over API: Promise.all resolves — balance deduct and seed fetch complete before PF call

    API->>PF: POST /api/pf/calculate { clientSeed: 'abc123', nonce: 42, serverSeed: 'a3f8...' }
    Note over PF: PF Worker is stateless — Gateway passes all inputs
    PF->>PF: HMAC-SHA256(serverSeed + ':' + clientSeed + ':' + nonce)
    PF->>PF: gameResult = parseInt(hash.slice(0,8), 16) % 100 + 1  →  22
    PF-->>API: { gameResult: 22, gameHash: 'd4e8f...' }

    Note over API: direction="under", gameResult=22 < target=50 → WIN
    API->>API: multiplier = 99 / (50 - 1) = 2.0204, payoutAmount = 10 * 2.0204 = 20.20

    Note over API: settleBetAsync (lua_credit_payout) and produceBetResolved are fire-and-forget for latency SLO
    API--)Redis: EVAL lua_credit_payout (settleBetAsync) — retries up to creditMaxAttempts (default 3) on transient Redis errors
    API--)Kafka: produce BetResolved { bet_id, user_id, chain, currency, wager, payout, result, hash, nonce, clientSeed } — .catch() logs KAFKA_PRODUCE_ERROR, no durable retry

    Note over API: newBalance in WS message = 90 (post-deduct, PRE-credit — lua_credit_payout not yet applied)
    API-->>N: WS send → { type: 'BET_RESULT', betId, gameResult: 22, gameHash, nonce: 42, wagerAmount: 10, payoutAmount: 20.20, target: 50, direction: 'under', multiplier: 2.0204, newBalance: 90, chain: 'ethereum', currency: 'ETH', timestamp }
    N-->>B: deliver WS frame
    Note over API,B: ← entire synchronous path above completes in <20ms

    Note over B: Frontend compensates for pre-credit newBalance:
    Note over B: displayedBalance = msg.newBalance + msg.payoutAmount = 90 + 20.20 = 110.20
    Note over B: (payoutAmount is 0 on a loss, so this formula is always correct)
    B->>B: updateBalance('ethereum', 'ETH', 110.20) — display win + correct balance

    Note over Kafka, PG: Async ACID settlement — independent of client response
    LC->>Kafka: consume BetResolved
    LC->>PG: INSERT INTO transactions (bet_id,...) ON CONFLICT (bet_id) DO NOTHING
    PG-->>LC: 1 row inserted
    LC->>Kafka: commit offset
```

### Reliability notes

**lua_credit_payout (settleBetAsync):** Fire-and-forget for latency; not awaited before WS send. `settleBetAsync` retries up to `creditMaxAttempts` (default 3) on transient Redis errors. On final failure it logs `REDIS_CREDIT_ERROR` and returns — funds remain in escrow until manual reconciliation or a future retry worker. The `WS send → { ... newBalance ... }` uses `optimisticBalance` (post-escrow, pre-credit); the frontend compensates with `displayedBalance = msg.newBalance + msg.payoutAmount`.

**BetResolved:** Fire-and-forget for latency. `.catch()` logs `KAFKA_PRODUCE_ERROR` with `betId` and `userId`; there is no durable retry. If produce fails, the Ledger Consumer never receives the event; reconciliation: API Gateway audit log has `BET_RESOLVED` for the bet; compare `transactions` table to audit logs to identify missing rows. **Recommended future:** RPUSH failed events to a Redis list (e.g. `kafka:bet_resolved:retry`) and a worker republishes with at-least-once semantics; or use Kafka producer with `acks: -1` and retries (currently used) plus a dead-letter queue for failed sends.

---

## Flow 7 — Bet, LOSS Path

Identical to Flow 6 up to payout calculation. Shown abbreviated for the key difference.

```mermaid
sequenceDiagram
    participant B as Browser
    participant API as API Gateway
    participant Redis as Redis
    participant PF as PF Worker
    participant Kafka as Kafka

    B->>API: WS → { type: "BET_REQUEST", wagerAmount: 10, clientSeed: "xyz", chain: "ethereum", currency: "ETH", target: 50, direction: "under" }
    API->>Redis: EVAL lua_balance_check_deduct → { success: true, newBalance: 90, nonce: 43 }
    API->>PF: POST /api/pf/calculate { clientSeed: "xyz", nonce: 43, serverSeed: "a3f8..." }
    PF-->>API: { gameResult: 72, gameHash: "a1b2..." }

    Note over API: direction="under", gameResult=72 >= target=50 → LOSS
    Note over API: payoutAmount = 0. lua_credit_payout (settleBetAsync) still runs — releases escrow, credits 0. produceBetResolved fire-and-forget.

    API--)Kafka: produce BetResolved { ..., payout: 0, result: 72 } — .catch() logs KAFKA_PRODUCE_ERROR
    API-->>B: WS → { type: "BET_RESULT", gameResult: 72, payoutAmount: 0, target: 50, direction: "under", newBalance: 90, ... }
    Note over B: Display loss. Balance reflects deducted wager only.
```

---

## Flow 8 — Bet, Insufficient Balance (Lua Rejection)

The atomic Lua script prevents any double-spend. The flow is aborted before game logic executes.

```mermaid
sequenceDiagram
    participant B as Browser
    participant API as API Gateway
    participant Redis as Redis
    participant PF as PF Worker

    B->>API: WS → { type: "BET_REQUEST", wagerAmount: 500, clientSeed: "seed", chain: "ethereum", currency: "ETH", target: 50, direction: "under" }
    API->>API: Zod validation passes (all fields valid)
    API->>Redis: EVAL lua_balance_check_deduct(userId, "ethereum", "ETH", 500)
    Note over Redis: Lua: IF balance (90) < wagerAmount (500) THEN return error
    Redis-->>API: { success: false, reason: "INSUFFICIENT_BALANCE" }

    Note over API: PF Worker is never called. No game logic executes. No Kafka event produced.
    API-->>B: WS → { type: "ERROR", code: "INSUFFICIENT_BALANCE", message: "Balance too low for this wager" }
    Note over B: Increment dicetilt_double_spend_rejections_total metric
```

---

## Flow 9 — Bet, Rate Limited (Sliding Window Triggered)

The sliding window rate limiter is **fully wired** into the WS bet handler. It is checked before any balance operation — rejections are cheap and do not touch Redis balance keys.

```mermaid
sequenceDiagram
    participant B as Browser
    participant API as API Gateway
    participant Redis as Redis

    B->>API: WS → { type: "BET_REQUEST", ... } (31st bet within the current 1-second window)
    API->>Redis: EVAL lua_rate_limit(key="ratelimit:{userId}:bet", now=Date.now(), windowSeconds=1, limit=30)
    Note over Redis: Lua (atomic): ZREMRANGEBYSCORE (prune entries older than 1s)
    Note over Redis: ZCARD → 30 (already at limit) → return 0
    Redis-->>API: 0 (rejected)

    API-->>B: WS → { type: "ERROR", code: "RATE_LIMITED", message: "Too many bets — slow down" }
    Note over API: Increment dicetilt_rate_limit_rejections_total{limiter_type="bet"}
    Note over API: Balance, PF Worker, and Kafka are never touched on rate-limited requests
```

> **Implementation:** `checkRateLimit(userId, 'bet', 1, 30)` — 30 bets per second per user. The Lua script uses a Redis ZSET keyed `ratelimit:{userId}:bet`. `dicetilt_rate_limit_rejections_total{limiter_type="bet"}` is incremented **only** when the rate-limit check succeeds and returns a rejection (limit exceeded). If the Redis call itself fails, the handler **fails closed** — reject the bet with `INTERNAL_ERROR`, increment `dicetilt_redis_error_rejections_total` (not `dicetilt_rate_limit_rejections_total`), and log `REDIS_UNAVAILABLE`.

---

## Flow 10 — Bet, Invalid Payload (Zod Rejection)

```mermaid
sequenceDiagram
    participant B as Browser
    participant API as API Gateway

    B->>API: WS → { type: 'BET_REQUEST', wagerAmount: -5, clientSeed: '' }
    API->>API: Zod.parse(frame) → ZodError: wagerAmount must be positive, clientSeed must not be empty

    Note over API: Short-circuit. Redis, PF Worker, and Kafka are never touched.
    API-->>B: WS → { type: 'ERROR', code: 'INVALID_PAYLOAD', message: 'wagerAmount must be > 0' }
```

---

## Flow 11 — Bet Amount Adjustment (Client-Side Only)

> **Note:** There is no server-side "reduce bet" concept. Each `BET_REQUEST` message is an independent, atomic wager. The client simply changes the wager input field value before clicking Roll. No server communication occurs until the next `BET_REQUEST` is sent.

```mermaid
sequenceDiagram
    participant User as User (Browser UI)
    participant JS as Client-Side JavaScript

    User->>JS: Types new wager amount in input field (e.g., changes 100 → 50)
    JS->>JS: validate: wagerAmount > 0 AND wagerAmount <= displayedBalance
    alt Valid amount
        JS->>JS: update UI wager display
        Note over JS: No network call. Server is not informed of the pending amount.
    else Invalid (zero, negative, or exceeds balance)
        JS->>User: disable Roll button, show inline error
    end

    User->>JS: clicks Roll
    JS->>JS: send WS → { type: "BET_REQUEST", wagerAmount: 50, clientSeed: "..." }
    Note over JS: Only at this point does the server process the bet
```

---

## Flow 12 — Provably Fair Status Check

```mermaid
sequenceDiagram
    participant B as Browser
    participant N as Nginx
    participant API as API Gateway
    participant Redis as Redis

    B->>N: GET /api/pf/status?chain=ethereum&currency=ETH  Authorization: Bearer {JWT}
    N->>API: route /api/pf/* (all PF routes go through Gateway)
    API->>API: jwt.verify(token) → { userId }
    API->>Redis: GET user:{userId}:serverSeed (or fallback to Postgres)
    Redis-->>API: activeServerSeed
    API->>API: SHA-256(activeServerSeed) → serverCommitment
    API->>Redis: GET user:{userId}:nonce:ethereum:ETH
    Redis-->>API: 42
    API-->>B: { serverCommitment: "9f3a...", currentNonce: 42 }

    Note over B: UI calls this with the currently selected wallet's chain+currency.
    Note over B: Displays serverCommitment hash in the Provably Fair panel.
    Note over B: PF Worker is not involved — Gateway handles status directly.
```

---

## Flow 13 — Provably Fair Seed Rotation + Client Browser Verification

```mermaid
sequenceDiagram
    participant B as Browser
    participant N as Nginx
    participant API as API Gateway
    participant PF as PF Worker
    participant PG as PostgreSQL

    B->>N: POST /api/pf/rotate-seed  Authorization: Bearer {JWT}
    N->>API: route (all /api/pf/* go through Gateway)
    API->>API: jwt.verify(token) → { userId }
    API->>API: fetch currentServerSeed from Redis/Postgres

    API->>PF: POST /api/pf/rotate-seed { currentServerSeed } (internal, PF_AUTH_TOKEN)
    PF->>PF: newServerSeed = crypto.randomBytes(32).toString('hex')
    PF->>PF: newCommitment = SHA256(newServerSeed)
    PF-->>API: { revealedSeed: currentServerSeed, newServerSeed, newCommitment }

    API->>PG: UPDATE users SET active_server_seed=newServerSeed, previous_server_seed=currentServerSeed WHERE id=$1
    API->>Redis: SET user:{userId}:serverSeed newServerSeed
    API->>Redis: SET user:{userId}:nonce:ethereum:ETH "0" (reset nonce for new cycle)

    API-->>B: { revealedServerSeed: "a3f8...", newCommitment: "7c2d..." }

    Note over B: Client-side verification loop (runs entirely in browser)
    B->>B: for each (clientSeed, nonce, result) in localAuditHistory:
    B->>B:   computed = HMAC-SHA256(revealedServerSeed + ":" + clientSeed + ":" + nonce) % 100 + 1
    B->>B:   assert computed === result
    B->>B: Display: "All X outcomes verified ✓"

    Note over B: If all assertions pass → server never manipulated any outcome.
    Note over B: New serverCommitment displayed for next betting cycle.
```

---

## Flow 14 — Caching: Balance Cache MISS (Hydration from Postgres)

Occurs on first login or after a Redis eviction. The API Gateway hydrates Redis before the Lua betting script runs.

```mermaid
sequenceDiagram
    participant B as Browser
    participant API as API Gateway
    participant Redis as Redis
    participant PG as PostgreSQL

    B->>API: WS → { type: "BET_REQUEST", wagerAmount: 10, clientSeed: "seed" }

    API->>Redis: GET user:{userId}:balance:ethereum:ETH
    Redis-->>API: (nil) — key does not exist

    Note over API: Cache-Aside hydration (Constraint 11)
    API->>PG: SELECT balance FROM wallets WHERE user_id=$1 AND chain='ethereum' AND currency='ETH'
    PG-->>API: "100.00000000"

    API->>Redis: SET user:{userId}:balance:ethereum:ETH "100.00000000"
    Note over Redis: Key now populated. Subsequent requests hit Redis directly.

    API->>Redis: EVAL lua_balance_check_deduct(userId, "ethereum", "ETH", 10)
    Redis-->>API: { success: true, newBalance: 90 }
    Note over API: Continue normal betting flow (see Flow 6)
```

---

## Flow 15 — Caching: Balance Cache HIT (Normal Path)

```mermaid
sequenceDiagram
    participant B as Browser
    participant API as API Gateway
    participant Redis as Redis

    B->>API: WS → { type: "BET_REQUEST", wagerAmount: 10, clientSeed: "seed" }

    API->>Redis: GET user:{userId}:balance:ethereum:ETH
    Redis-->>API: "90.00000000" — key exists

    API->>Redis: EVAL lua_balance_check_deduct(userId, "ethereum", "ETH", 10)
    Note over Redis: Single atomic EVAL: check and deduct in one operation
    Redis-->>API: { success: true, newBalance: 80 }

    Note over API: No Postgres query. Entire balance operation completes in <1ms.
    Note over API: Continue to PF Worker → Kafka → WS response (Flow 6)
```

---

## Flow 16 — Caching: Balance Eviction Recovery

When Redis evicts a balance key under memory pressure, the next bet triggers hydration before proceeding.

```mermaid
sequenceDiagram
    participant Redis as Redis
    participant API as API Gateway
    participant PG as PostgreSQL
    participant Monitor as Prometheus / Grafana

    Note over Redis: Memory limit reached — LRU eviction policy
    Redis->>Redis: evict user:{userId}:balance:ethereum:ETH
    Redis->>Monitor: increment redis_evicted_keys_total metric
    Monitor->>Monitor: dicetilt_redis_cache_hit_rate drops — visible on Grafana dashboard

    Note over API: Next bet request arrives for this user
    API->>Redis: GET user:{userId}:balance:ethereum:ETH
    Redis-->>API: (nil)

    API->>PG: SELECT balance FROM wallets WHERE user_id=$1 AND chain='ethereum' AND currency='ETH'
    PG-->>API: canonical balance
    API->>Redis: SET user:{userId}:balance:ethereum:ETH {balance}
    Note over API: Cache re-hydrated. Betting proceeds normally.
    Note over Monitor: Grafana: Redis hit rate recovers as key is re-cached on subsequent requests
```

---

## Flow 17 — WebSocket PING / PONG Keep-Alive

```mermaid
sequenceDiagram
    participant B as Browser
    participant API as API Gateway

    loop Every 30 seconds
        B->>API: WS send → { type: "PING" }
        API-->>B: WS send → { type: "PONG" }
    end

    Note over API: If no PING received within configurable timeout (e.g., 90s),
    Note over API: server closes the WebSocket and frees the connection slot.
```

---

## Flow 18 — WebSocket Connection State Machine

```mermaid
stateDiagram-v2
    [*] --> CONNECTING : Client initiates bare WS upgrade (no JWT in URL or headers)

    CONNECTING --> AUTH_PENDING : HTTP 101 accepted — 10s auth timer started
    AUTH_PENDING --> AUTHENTICATED : AUTH frame received, JWT valid, session active, connection cap not exceeded
    AUTH_PENDING --> REJECTED : 10s timeout elapsed with no AUTH frame
    AUTH_PENDING --> REJECTED : First frame is not AUTH, or JWT invalid / expired
    AUTH_PENDING --> REJECTED : Session revoked or per-user connection limit (5) reached

    REJECTED --> [*] : ws.close(1008) — connection terminated

    AUTHENTICATED --> BETTING : WS BET_REQUEST received and Zod-validated
    AUTHENTICATED --> AUTHENTICATED : PING received → PONG sent
    AUTHENTICATED --> AUTHENTICATED : BALANCE_UPDATE pushed (Redis Pub/Sub after deposit)
    AUTHENTICATED --> AUTHENTICATED : WITHDRAWAL_COMPLETED pushed (Redis Pub/Sub after payout tx mined)
    AUTHENTICATED --> CLOSED : SIGTERM / idle timeout / client disconnects

    BETTING --> AUTHENTICATED : BET_RESULT sent (win or loss resolved <20ms)
    BETTING --> AUTHENTICATED : ERROR sent (INSUFFICIENT_BALANCE / RATE_LIMITED / INVALID_PAYLOAD)

    AUTHENTICATED --> REVOKED : SESSION_REVOKED pushed (admin deleted session key)
    REVOKED --> [*] : Client must re-authenticate via EIP-712

    CLOSED --> [*] : Connection terminated, resources freed
```

---

## Flow 19 — Developer & Testing Infrastructure

### 19.1 `TEST_MODE` Dev Token Endpoint

When `TEST_MODE=true` (set in `docker-compose.yml`), the API Gateway exposes an additional route that bypasses EIP-712 wallet signing. This is used by the k6 load tests to authenticate programmatically without a real wallet.

```mermaid
sequenceDiagram
    participant K6 as k6 Load Test Script
    participant API as API Gateway (TEST_MODE=true)
    participant PG as PostgreSQL
    participant Redis as Redis

    Note over K6: Load test needs a JWT without going through EIP-712
    K6->>API: GET /api/v1/dev/token?walletIndex=0
    Note over API: Route only active when config.testMode && NODE_ENV !== 'production'
    API->>API: derive deterministic Hardhat wallet address for index 0
    API->>API: upsert user + wallets in Postgres (same logic as /auth/verify)
    API->>Redis: SET session:{userId} "active" EX 86400
    API->>Redis: SET user:{userId}:balance:ethereum:ETH "10"
    API->>API: jwt.sign({ userId, walletAddress }) → JWT
    API-->>K6: { token: "eyJ..." }

    Note over K6: Use JWT for all subsequent WS connections and REST calls
```

> **Security:** This endpoint is guarded by `config.testMode && process.env.NODE_ENV !== 'production'`; otherwise it returns 404. A startup sanity check exits the process if `TEST_MODE=true` while `NODE_ENV=production` to catch misconfiguration early. The `TEST_MODE` env var is explicitly set to `"true"` only in `docker-compose.yml` and only for the PoC demo stack.

---

### 19.2 `/?demo=1` Frontend Shortcut

Opening the frontend at `http://localhost/?demo=1` pre-loads Hardhat account #1 (index 1) as the burner wallet instead of generating a random one. This account is pre-funded on Anvil and makes it easy to test the Deposit flow without manually copying a private key.

**Security:** Demo mode is gated by `DEMO_MODE = isLocalhost() && params.get('demo') === '1'`. The test mnemonic is only used when the hostname is `localhost`, `127.0.0.1`, or `*.local`; on production domains, `?demo=1` is ignored and `ethers.Wallet.createRandom()` is used. For production builds, run `BUILD_ENV=production node scripts/build-frontend.js` to strip the mnemonic entirely — output goes to `frontend/dist/`. API/WS URLs use `location.origin` / `location.host`, so demo is implicitly limited to the page's origin (localhost when testing locally).

```mermaid
sequenceDiagram
    participant Browser as Browser
    participant JS as index.html JavaScript
    participant Anvil as Hardhat/Anvil :8545

    Browser->>JS: load index.html?demo=1
    JS->>JS: DEMO_MODE = isLocalhost() && params.get('demo') === '1'
    Note over JS: Only true on localhost / 127.0.0.1 / *.local
    JS->>JS: if DEMO_MODE: wallet = HDNodeWallet.fromMnemonic(Hardhat mnemonic, "m/44'/60'/0'/0/1")
    Note over JS: Hardhat account #1 — deterministic, pre-funded with 10000 ETH by Anvil
    JS->>JS: else: ethers.Wallet.createRandom() or stored from localStorage
    JS->>Anvil: eth_getBalance(account1Address) — confirm funded (when demo)
    Anvil-->>JS: "10000000000000000000000" (10000 ETH)
    Note over JS: Continue normal auth flow (EIP-712 challenge → verify → JWT → WS)
```

> **Purpose:** Simplifies recruiter demos of the Deposit feature. Hardhat account #1's wallet address is already known to the system after a normal auth flow, and its large ETH balance makes it easy to demonstrate multiple on-chain deposits without running out of test ETH.
