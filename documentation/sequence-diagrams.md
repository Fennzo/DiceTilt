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
    API-->>N: { nonce: "a3f8..." }
    N-->>B: { nonce: "a3f8..." }

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
        API->>API: INSERT INTO wallets (user_id, solana, SOL, balance=10, wallet_address) — both chains; Solana address placeholder until user connects Solana keypair
        API->>Redis: SET session:{userId} "active" EX 86400
        API->>Redis: SET user:{userId}:nonce:ethereum:ETH "0" (and solana:SOL) — nonce lives in Redis
        API->>Redis: SET user:{userId}:balance:ethereum:ETH "10" (and solana:SOL) — default balance
        API->>API: jwt.sign({ userId, walletAddress }) → JWT

        API-->>B: { token: "eyJ..." }
        Note over B: Store JWT in memory (not localStorage — XSS risk)
    else Signature invalid
        API-->>B: HTTP 401 { error: "INVALID_SIGNATURE" }
    end
```

---

## Flow 2 — WebSocket Connection Upgrade

After obtaining a JWT, the client upgrades to a persistent WebSocket connection.

```mermaid
sequenceDiagram
    participant B as Browser
    participant N as Nginx
    participant API as API Gateway
    participant Redis as Redis

    B->>N: GET /ws  Upgrade: websocket  Authorization: Bearer {JWT}
    Note over N: nginx.conf must pass Upgrade + Connection headers (Constraint 13)
    N->>API: forward WebSocket upgrade request

    API->>API: jwt.verify(token) → { userId, walletAddress, exp }

    alt JWT expired or malformed
        API-->>B: HTTP 401 — connection refused
    else JWT valid
        API->>Redis: GET session:{userId}
        Redis-->>API: "active"

        alt Session revoked (key missing)
            API-->>B: HTTP 401 — connection refused
        else Session active
            API->>API: register WebSocket connection in memory map (userId → ws socket)
            API-->>B: HTTP 101 Switching Protocols
            Note over B, API: Persistent bi-directional connection established
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

    B->>N: WS send → { type: "BET_REQUEST", wagerAmount: 10, clientSeed: "abc123", chain: "ethereum", currency: "ETH", target: 50, direction: "under" }
    N->>API: route WebSocket frame

    API->>API: Zod.parse(frame) — validate all fields (wagerAmount > 0, target 2–98, direction, chain, currency, clientSeed ≤ 64 chars)
    API->>API: check Redis session:{userId} still active

    API->>Redis: EVAL lua_balance_check_deduct(userId, "ethereum", "ETH", 10)
    Note over Redis: Atomic: GET balance, assert >= wager, SET balance - wager, INCR nonce, return newBalance + nonce
    Redis-->>API: { success: true, newBalance: 90, nonce: 42 }

    API->>API: fetch serverSeed from Redis/Postgres for userId
    API->>PF: POST /api/pf/calculate { clientSeed: "abc123", nonce: 42, serverSeed: "a3f8..." }
    Note over PF: PF Worker is stateless — Gateway passes all inputs
    PF->>PF: HMAC-SHA256(serverSeed + ":" + clientSeed + ":" + nonce)
    PF->>PF: gameResult = parseInt(hash.slice(0,8), 16) % 100 + 1  →  22
    PF-->>API: { gameResult: 22, gameHash: "d4e8f..." }

    Note over API: direction="under", gameResult=22 < target=50 → WIN
    API->>API: multiplier = 99 / (50 - 1) = 2.0204; payoutAmount = 10 * 2.0204 = 20.20
    API->>Redis: EVAL lua_credit_payout(userId, "ethereum", "ETH", 20.20)
    Redis-->>API: { newBalance: 110.20 }

    API->>Kafka: produce BetResolved { bet_id: uuid, user_id, chain, currency, wager: 10, payout: 20.20, result: 22, hash: "d4e8...", nonce: 42, clientSeed }
    Note over API,B: ← entire path above completes in <20ms

    API-->>N: WS send → { type: "BET_RESULT", betId, gameResult: 22, gameHash, nonce: 42, wagerAmount: 10, payoutAmount: 20.20, target: 50, direction: "under", multiplier: 2.0204, newBalance: 110.20, chain: "ethereum", currency: "ETH", timestamp }
    N-->>B: display win + updated balance

    Note over Kafka, PG: Async ACID settlement — independent of client response
    LC->>Kafka: consume BetResolved
    LC->>PG: INSERT INTO transactions (bet_id,...) ON CONFLICT (bet_id) DO NOTHING
    PG-->>LC: 1 row inserted
    LC->>Kafka: commit offset
```

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
    Note over API: payoutAmount = 0. No Redis credit step.

    API->>Kafka: produce BetResolved { ..., payout: 0, result: 72 }
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

```mermaid
sequenceDiagram
    participant B as Browser
    participant API as API Gateway
    participant Redis as Redis

    B->>API: WS → { type: "BET_REQUEST", ... } (61st request within 60 seconds)
    API->>Redis: EVAL lua_sliding_window_check(ip, windowMs=60000, limit=60)
    Note over Redis: Lua: ZREMRANGEBYSCORE (prune old), ZCOUNT (count in window)
    Note over Redis: count = 61 > limit = 60 → reject
    Redis-->>API: { allowed: false, retryAfter: 3400 }

    API-->>B: WS → { type: "ERROR", code: "RATE_LIMITED", message: "Too many requests" }
    Note over API: Increment dicetilt_rate_limit_rejections_total{limiter_type="sliding_window"}
```

---

## Flow 10 — Bet, Invalid Payload (Zod Rejection)

```mermaid
sequenceDiagram
    participant B as Browser
    participant API as API Gateway

    B->>API: WS → { type: "BET_REQUEST", wagerAmount: -5, clientSeed: "" }
    API->>API: Zod.parse(frame) → ZodError: wagerAmount must be positive; clientSeed must not be empty

    Note over API: Short-circuit. Redis, PF Worker, and Kafka are never touched.
    API-->>B: WS → { type: "ERROR", code: "INVALID_PAYLOAD", message: "wagerAmount must be > 0" }
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
    [*] --> CONNECTING : Client initiates WS upgrade with JWT

    CONNECTING --> AUTHENTICATED : JWT valid + Redis session key exists
    CONNECTING --> REJECTED : JWT invalid / expired / session revoked

    REJECTED --> [*] : HTTP 401 — connection closed

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
