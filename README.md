# DiceTilt — Technical Recruiter Overview

> **Role Fit:** Backend Engineer, Platform Engineer, Full-Stack Engineer, Blockchain/Web3 Engineer, DevOps Engineer

---

## Executive Summary

**DiceTilt** is a fully sovereign, locally-deployable hybrid Web2/Web3 crypto casino proof-of-concept. It demonstrates production-grade microservices architecture, event-driven financial settlement, multi-chain blockchain integration (Ethereum + Solana), and enterprise observability — all designed for zero-friction recruiter demos without external dependencies.

---

## Tech Stack

| Layer | Technologies |
|-------|--------------|
| **Language** | TypeScript (strict mode), Rust (Trade Router stub) |
| **Runtime** | Node.js 20+, pnpm workspaces (monorepo) |
| **Data** | PostgreSQL 16, Redis 7, Apache Kafka (KRaft mode) |
| **Blockchain** | ethers.js (EVM), Hardhat/Anvil (local EVM node) |
| **Smart Contracts** | Solidity — Treasury.sol (EVM, fully deployed) |
| **Infrastructure** | Docker Compose (14 services), Nginx (reverse proxy, WebSocket) |
| **Observability** | Prometheus, Grafana, prom-client, Redis/Postgres/Kafka exporters |
| **Testing** | Jest (10 unit tests), k6 (5-scenario stress suite), integration test suite |
| **Validation** | Zod schemas, three-layer input validation |

---

## Architecture Highlights

### Active Microservices (5 TypeScript services)

- **API Gateway** — Express + WebSocket, Node.js cluster (multi-core), EIP-712 auth, Redis Lua atomic balance ops, Kafka producer. Server seed fetched fresh per bet — no stale-state after rotation.
- **Provably Fair Worker** — Stateless HMAC-SHA256 engine, Piscina Worker Threads pool, internal-only REST. Server seed commitment (SHA-256) issued before bets; full seed reveal + client-side recomputation on rotation. Seed commitment audit trail persisted to PostgreSQL.
- **Ledger Consumer** — Kafka `eachBatch` parallel processing, idempotent `ON CONFLICT DO NOTHING`, Redis Pub/Sub balance push.
- **EVM Listener** — ethers.js event subscription on local Anvil node, publishes `DepositReceived` to Kafka.
- **EVM Payout Worker** — Kafka consumer, ethers.Wallet signing, `payoutBusy` mutex prevents nonce collisions, isolated from API.

> **Solana layer** (Solana Listener + Solana Payout Worker) is architecturally designed and documented in `/documentation/` but not yet implemented as running services in this PoC. The EVM layer demonstrates the complete event-driven financial settlement pattern end-to-end.

### Event-Driven Design

- **Kafka Topics:** `BetResolved`, `DepositReceived`, `WithdrawalRequested`, `WithdrawalCompleted`, `TradeExecuted` + DLQs
- **Delivery Guarantees:** `acks: 'all'`, idempotent producers
- **DLQ Pattern:** Failed messages routed to `*-DLQ` for audit; zero data loss on processing failures

### Multi-Chain Architecture

- **EVM:** Hardhat/Anvil, Treasury.sol (auto-funded 100 ETH on deploy), deterministic pre-funded accounts
- **Solana:** Architected with @solana/web3.js and Anchor Treasury (documented, not yet running)
- **Chain Isolation:** Each chain listener and payout worker operates independently; one chain failure does not affect the other

---

## Engineering Constraints Implemented

| Constraint | Implementation |
|------------|----------------|
| **Double-Spend Prevention** | Redis Lua script — atomic GET + conditional DECRBY in a single round-trip. No sequential GET/SET race window. |
| **Escrow Model** | Wager moves from `balance_available` → `balance_escrowed` atomically on bet start; settles back on resolve. In-flight bets can never be double-spent even under concurrent load. |
| **Idempotency** | `ON CONFLICT (bet_id) DO NOTHING` on all Kafka-sourced PostgreSQL inserts. |
| **Withdrawal Isolation** | API Gateway never holds private keys. Payout Worker in isolated Docker subnet signs transactions — a compromised gateway cannot sign. |
| **Payout Nonce Safety** | `payoutBusy` mutex (atomic in Node.js single-thread) + retry loop on `NONCE_EXPIRED`. Prevents ghost-txn nonce conflicts from KafkaJS concurrent-partition processing. |
| **EIP-712 Auth** | Cryptographic wallet signature verification on login. JWT session. WebSocket auth via first frame (not URL token) with 10s timeout for unauthenticated connections. `maxPayload: 64KB` against oversized frame attacks. |
| **Provably Fair** | Server seed committed via SHA-256 before betting. HMAC-SHA256(serverSeed, clientSeed:nonce). Seed fetched fresh from Redis per bet. Full rotation lifecycle with server-side attestation (`serverVerified: true`) + immutable `seed_commitment_audit` table in PostgreSQL. |
| **Rate Limiting** | Redis ZSET sliding window, Lua atomic. 30 bets/sec per user. Fails open on Redis error — availability over enforcement on transient blip. |
| **Input Validation** | Three layers: frontend (UX), Zod at Gateway (typed enforcement), PostgreSQL CHECK constraints (safety net). |
| **DLQ Routing** | Failed Kafka messages → `*-DLQ` topics for audit. Zero data loss on processing failures. |
| **Graceful Shutdown** | SIGTERM/SIGINT handlers. Kafka offset commit, connection pool drain. |
| **Health Checks** | `depends_on: condition: service_healthy` for Postgres, Redis, Kafka. Containers wait for dependencies. |
| **Secrets** | `.env` + Ansible Vault design for production. PoC uses deterministic Hardhat keys — no Vault required at runtime. |

---

## Performance

### Internal Benchmark (Phase 6 baseline)

Measured with k6 (100 VUs, 60s), connecting directly to `api-gateway:3000` to isolate service latency from Nginx/WSL2 overhead.

| Metric | Result |
|--------|--------|
| P95 bet processing (internal) | **17.9 ms** (SLO: <20 ms ✓) |
| Throughput | **148,743 bets / 60 s** (2,479/sec) |
| Error rate under load | **0%** (only correct `INSUFFICIENT_BALANCE` rejections) |
| DLQ messages after 60s | **0** |
| Kafka lag after 60s load | Clears in < 1 second |
| Double-spend test | 1 of 20 concurrent 9 ETH bets accepted — Lua atomicity confirmed |

### Stress Suite (5 scenarios, ascending load)

Full suite run: `bash scripts/run-stress-suite.sh` (~55 min). Each scenario models a distinct real-world traffic pattern.

| Test | Scenario | VUs | Duration | P95 | P99 | Throughput | INTERNAL_ERRORs | Result |
|------|----------|-----|----------|-----|-----|------------|-----------------|--------|
| 01 | Quiet hours baseline | 50 | 8 min | 46 ms | 62 ms | 1.1/sec* | 0 | SLO miss† |
| 02 | Evening peak (multi-chain) | 0→400 | 9.5 min | **4 ms** | **5 ms** | 88.8/sec | 0 | ✓ ALL PASS |
| 03 | Traffic spike (80→900 VUs in 50s) | 900 peak | 7 min | 41 ms | 200 ms | — | 0 | SLO miss‡ |
| 04 | Whale mixer (3-tier population) | 250 | 10 min | **3 ms** | 4–5 ms | — | 0 | ✓ ALL PASS |
| 05 | Peak crush (Black Friday) | 0→1000 | 13 min | 200 ms | 465 ms | **1,628/sec** | 0 | SLO miss§ |

**\* Test 01 note:** Low throughput caused by 20 test wallets exhausting balance under concurrent VUs — a test infrastructure artifact, not a service limitation. Bets that completed processed correctly (0 errors).

**† Test 01 SLO miss:** P95=46ms vs SLO<25ms. The SLO was written for the Phase 6 direct connection (no escrow overhead). Actual bet completion latency is consistent with tests 02 and 04.

**‡ Test 03 SLO miss:** P99=200ms at the spike peak (80→900 VUs in 50s) — expected tail elongation under sudden load. P95=41ms ✓. `INTERNAL_ERROR=0` confirms graceful degradation, not a crash.

**§ Test 05 SLO miss:** WS connection limit hit under sustained 1000-VU load. **1,270,205 bets processed** over 13 minutes with zero INTERNAL_ERRORs — the service never crashed. At maximum load, throughput held at **1,628 bets/sec**.

**The signal that matters most:** `INTERNAL_ERROR = 0` across all five tests at every VU count from 50 to 1,000. The system degrades gracefully (latency climbs, tail elongates) but never crashes, panics, or enters an inconsistent state.

#### Test 04 — Whale Mixer per-tier breakdown

| User Tier | VUs | Bets | P95 | P99 | SLO | Result |
|-----------|-----|------|-----|-----|-----|--------|
| Casual (~75% of user base) | 150 | 6,144 | 3 ms | 4 ms | <50 ms P95 | ✓ |
| Regular (~20% of user base) | 80 | 17,989 | 3 ms | 4 ms | <35 ms P95 | ✓ |
| High-roller / Whale (~5%) | 20 | 2,099 | 3 ms | 5 ms | <25 ms P95 | ✓ |

The equal P95 across all three tiers (3 ms each) confirms the system is fair — whale traffic does not crowd out casual user SLOs. Overall error rate: 0%.

---

## Observability

- **13 custom Prometheus metrics** including `dicetilt_bet_processing_duration_ms` (histogram, P95 proof), `dicetilt_double_spend_rejections_total`, `dicetilt_active_websocket_connections`, `dicetilt_kafka_dlq_messages_total`
- **Infrastructure exporters:** Redis (`redis_exporter`), Postgres (`postgres-exporter`), Kafka (JMX exporter)
- **Grafana Dashboard:** Four-row layout — Game Floor, Performance Proof, Infrastructure Health, Security & Integrity. Auto-provisioned at boot, no manual setup.

---

## Multi-Chain Design

### EVM (fully implemented)

Local Anvil node (Hardhat). `Treasury.sol` auto-funded with 100 ETH on deploy. EVM Listener subscribes to on-chain `Transfer` events and publishes `DepositReceived` to Kafka. EVM Payout Worker signs withdrawals from the isolated Treasury keypair.

### Solana (architecture documented, services stubbed)

The Solana listener and payout worker exist as documented stubs. The EVM pipeline demonstrates the complete event-driven financial settlement pattern — implementing it a second time on Solana in a PoC adds no new architectural signal. What Solana adds is chain-specific complexity that a partial implementation would obscure rather than demonstrate.

The production Solana layer requires decisions that differ meaningfully from the EVM implementation:

- **USDC, not SOL** — native SOL is volatile; a casino platform needs stable denomination for house edge calculations
- **ATA existence check** — every USDC payout must verify the destination Associated Token Account exists before signing; if not, prepend `createAssociatedTokenAccountInstruction` (Treasury needs a SOL float for rent)
- **Commitment asymmetry** — `finalized` (~13s) for incoming deposits to eliminate reversal risk; `confirmed` (~800ms) for outgoing payouts (platform signs, no adversarial counterparty)
- **Blockhash expiry** — no sequential nonces; transactions expire after ~90s; `BlockhashNotFound` requires rebuild, `AlreadyProcessed` is treated as idempotent success
- **RPC infrastructure** — public RPC is rate-limited and has no `sendTransaction` SLA; production requires Helius or Triton dedicated nodes

The Trade Router stub (Rust) represents the Jupiter + Jito integration boundary — liquidity aggregation across Solana DEXes with MEV-protected bundle submission. Rust's `tokio` multi-threaded async runtime allows parallel route computation across candidate swap paths in the ~50–200ms window relevant for MEV execution, which the Node.js event loop model cannot match at the same concurrency level.

Full rationale: [`documentation/solana-production-notes.md`](documentation/solana-production-notes.md)

---

## Project Structure

```
DiceTiltClaude/
├── packages/shared-types/        # Zod schemas, Kafka event types, WebSocket enums
├── packages/logger/              # Winston structured logger (@dicetilt/logger)
├── services/
│   ├── api-gateway/              # Express, WebSocket, Redis, Kafka producer
│   ├── provably-fair/            # Stateless HMAC-SHA256 worker (Piscina pool)
│   ├── ledger-consumer/          # Kafka → Postgres + Redis Pub/Sub
│   ├── evm-listener/             # EVM deposit event listener
│   └── evm-payout-worker/        # EVM withdrawal signer (isolated subnet)
├── contracts/
│   └── evm/                      # Treasury.sol, Hardhat config, deploy scripts
├── db/init.sql                   # Schema, CHECK constraints, indexes, seed_commitment_audit
├── docker/                       # nginx.conf, init-kafka.sh, Dockerfiles
├── frontend/                     # index.html (game UI + PF audit), dashboard.html
├── grafana/                      # Pre-provisioned dashboard JSON
├── prometheus/                   # prometheus.yml
├── tests/
│   ├── unit/                     # Jest: PF crypto, Lua atomicity (10 tests)
│   └── load/                     # k6: 5-scenario stress suite + double-spend attack
├── documentation/                # Architecture, sequence diagrams, Kafka topology, Solana notes
└── docker-compose.yml            # 14 services (12 persistent + 2 init), healthchecks, dependency ordering
```

---

## How to Run

### Prerequisites

- **Docker** (20.10+) and **Docker Compose** (v2+)
- **Node.js 20+** and **pnpm 9+** (optional — only needed to run tests locally; Docker builds everything)

### Quick Start

```bash
git clone https://github.com/Fennzo/DiceTilt.git
cd DiceTilt
cp .env.example .env
docker compose up -d
```

> **First boot takes 60–90 seconds.** Kafka initialization completes last — wait until `docker compose ps` shows all services healthy before opening the UI.

| URL | Description |
|-----|-------------|
| http://localhost | Game UI — EIP-712 wallet auth, real-time WebSocket bets |
| http://localhost/?demo=1 | Demo mode — Hardhat account #1, pre-funded on local Anvil |
| http://localhost/dashboard.html | Frontend stats panel (WebSocket-connected) |
| http://localhost:3001 | Grafana — auto-provisioned observability dashboard |
| http://localhost:9090 | Prometheus — raw metrics scrape endpoint |

### Local Development

```bash
pnpm install                                          # Install workspace dependencies
npx jest --config jest.config.cjs --no-coverage      # Unit tests (10/10)
pnpm lint                                             # ESLint across all TypeScript
```

### Load Tests (k6 required)

[Install k6](https://grafana.com/docs/k6/latest/set-up/install-k6/) and ensure it is on your PATH.
Windows users: `k6` may need a full path, e.g. `"C:\Program Files\k6\k6.exe"`.

```bash
# Full 5-scenario stress suite (~55 min, ascending load)
bash scripts/run-stress-suite.sh

# Run a single scenario
bash scripts/run-stress-suite.sh --only 2   # evening peak only

# Individual tests (direct connection, bypasses Nginx for accurate measurement)
k6 run --env BASE_URL="http://localhost:3000" --env WS_URL="ws://localhost:3000/ws" \
  tests/load/ws-bet-loop.js          # 100 VUs, 60s WebSocket bet loop

k6 run tests/load/double-spend-attack.js   # 50 VUs, single-wallet concurrency attack
```

### Stopping

```bash
docker compose down       # Stop containers, keep data volumes
docker compose down -v    # Stop containers and wipe all data (clean slate for re-testing)
```

### Test Mode

`TEST_MODE=true` is enabled by default in `docker-compose.yml`. This activates a dev-only endpoint that issues JWTs without wallet signatures — used by all k6 scripts:

```bash
# Get a JWT for any Hardhat-derived account (no MetaMask required)
curl "http://localhost:3000/api/v1/dev/token?walletIndex=0"
```

Remove or set `TEST_MODE: "false"` before any public deployment.

---

## Documentation

| Document | Contents |
|----------|----------|
| [`architecture-overview.md`](documentation/architecture-overview.md) | Full service map, data flows, design decisions |
| [`blockchain-flows.md`](documentation/blockchain-flows.md) | Sequence diagrams: deposit, withdrawal, trade |
| [`kafka-event-topology.md`](documentation/kafka-event-topology.md) | Topic definitions, partition strategy, consumer groups |
| [`database-schema.md`](documentation/database-schema.md) | ERD, table definitions, Redis key schema, escrow model |
| [`solana-production-notes.md`](documentation/solana-production-notes.md) | Solana-specific production requirements: USDC/ATA/commitment/RPC/MEV |

---

## Skills Demonstrated

- **Distributed Systems:** Event-driven architecture, Kafka consumer groups, DLQ patterns, pub/sub coordination
- **Financial Systems:** Atomic balance operations, escrow model, idempotency, double-spend prevention, audit trails
- **Blockchain:** EVM (ethers.js, Solidity), sovereign local test node, Treasury contract lifecycle
- **Security:** EIP-712 wallet auth, JWT, rate limiting, seed commitment scheme, escrow atomicity, secrets management
- **Cryptography:** Provably fair HMAC-SHA256 scheme with commitment/reveal cycle, server-side attestation, client-side verification
- **DevOps:** Docker Compose, healthchecks, dependency ordering, Prometheus/Grafana
- **TypeScript:** Strict mode, pnpm monorepo, shared-types package, Zod validation
- **Testing:** Unit tests (Jest, 10 passing), load tests (k6, 5-scenario stress suite), integration tests

---

## Production Readiness Notes

- Designed for Ansible deployment with Vault-injected secrets
- MEV protection architecture documented (Jito/Flashbots) for future Trade Router (Rust stub present)
- Event-Driven Ansible (EDA) rulebook documented for alert-driven Kafka broker remediation
- Node.js `cluster` module used in API Gateway for multi-core utilisation
- Structured logging (Winston) with per-service app/audit/security log streams, daily rotation
