# DiceTilt — Technical Recruiter Overview

> **Role Fit:** Backend Engineer, Platform Engineer, Full-Stack Engineer, Blockchain/Web3 Engineer, DevOps Engineer

---

## Executive Summary

**DiceTilt** is a fully sovereign, locally-deployable hybrid Web2/Web3 crypto casino proof-of-concept. It demonstrates production-grade microservices architecture, event-driven financial settlement, multi-chain blockchain integration (Ethereum + Solana), and enterprise observability—all designed for zero-friction recruiter demos without external dependencies.

---

## Tech Stack

| Layer | Technologies |
|-------|--------------|
| **Language** | TypeScript (strict mode), Rust (Trade Router stub) |
| **Runtime** | Node.js 20+, pnpm workspaces (monorepo) |
| **Data** | PostgreSQL 16, Redis 7, Apache Kafka (KRaft mode) |
| **Blockchain** | ethers.js (EVM), Hardhat/Anvil (local EVM node) |
| **Smart Contracts** | Solidity — Treasury.sol (EVM, fully deployed) |
| **Infrastructure** | Docker Compose (13 services), Nginx (reverse proxy, WebSocket) |
| **Observability** | Prometheus, Grafana, prom-client, Redis/Postgres/Kafka exporters |
| **Testing** | Jest (10 unit tests), k6 (load tests), integration test suite |
| **Validation** | Zod schemas, three-layer input validation |

---

## Architecture Highlights

### Active Microservices (5 TypeScript services)

- **API Gateway** — Express + WebSocket, Node.js cluster (multi-core), EIP-712 auth, Redis Lua atomic balance deductions, Kafka producer. Seed fetched fresh per bet to prevent stale-state after rotation.
- **Provably Fair Worker** — Stateless HMAC-SHA256 engine, piscina Worker Threads pool, internal-only REST. Server seed commitment (SHA-256) issued before bets; full seed reveal + client-side recomputation on rotation.
- **Ledger Consumer** — Kafka `eachBatch` parallel processing, idempotent `ON CONFLICT DO NOTHING`, Redis Pub/Sub balance push
- **EVM Listener** — ethers.js event subscription on local Anvil node, publishes `DepositReceived` to Kafka
- **EVM Payout Worker** — Kafka consumer, ethers.Wallet signing, `payoutBusy` mutex prevents nonce collisions, isolated from API

> **Solana layer** (Solana Listener + Solana Payout Worker) is architecturally designed and documented in `/documentation/` but not yet implemented as running services in this PoC. EVM layer is fully functional.

### Event-Driven Design

- **Kafka Topics:** `BetResolved`, `DepositReceived`, `WithdrawalRequested`, `WithdrawalCompleted`, `TradeExecuted` + DLQs
- **Delivery Guarantees:** `acks: 'all'`, idempotent producers
- **DLQ Pattern:** Failed messages routed to `*-DLQ` for audit; zero data loss

### Multi-Chain Architecture

- **EVM:** Hardhat/Anvil, Treasury.sol (auto-funded 100 ETH on deploy), deterministic pre-funded accounts
- **Solana:** Architected with @solana/web3.js and Anchor Treasury (documented, not yet running)
- **Chain Isolation:** Each chain listener and payout worker operates independently; one chain failure does not affect the other

---

## Engineering Constraints Implemented

| Constraint | Implementation |
|------------|----------------|
| **Double-Spend Prevention** | Redis Lua script (atomic GET + DECRBY) — no sequential GET/SET race window |
| **Idempotency** | `ON CONFLICT (bet_id) DO NOTHING` on PostgreSQL inserts |
| **Secrets** | `.env` + Ansible Vault design for production; deterministic PoC keys |
| **Withdrawal Isolation** | API Gateway never holds private keys; Payout Worker signs in isolated subnet |
| **EIP-712 Auth** | Cryptographic wallet signature verification, JWT session, WebSocket upgrade guard |
| **Provably Fair** | Server seed committed via SHA-256 before betting; HMAC-SHA256(serverSeed, clientSeed:nonce); seed fetched fresh from Redis per bet (no stale cache); full rotation lifecycle with client-side hash verification panel |
| **Graceful Shutdown** | SIGTERM/SIGINT handlers, Kafka offset commit, connection pool drain |
| **Health Checks** | `depends_on: condition: service_healthy` for Postgres, Redis, Kafka |
| **Rate Limiting** | Redis ZSET sliding window, Lua atomic, HTTP 429 |
| **Input Validation** | Layer 1 (frontend UX), Layer 2 (Zod at Gateway), Layer 3 (PostgreSQL CHECK) |
| **Payout Nonce Safety** | `payoutBusy` mutex in single-threaded Node.js + retry loop on NONCE_EXPIRED, avoids race from ghost txns |

---

## Proven Performance

| Metric | Result |
|--------|--------|
| **P95 bet processing** | **17.9 ms** (SLO: <20ms ✓) |
| **Throughput** | **148,743 bets / 60 seconds** (2,479/sec) |
| **Error rate under load** | **0%** (only correct INSUFFICIENT_BALANCE rejections) |
| **DLQ messages after load test** | **0** |
| **Double-spend test** | 1 of 20 concurrent 9 ETH bets accepted — Lua atomicity proven |
| **Kafka lag after 60s load** | Clears in <1 second |

Measured with k6 (100 VUs, 60s) connecting directly to `api-gateway:3000` (bypassing Nginx to isolate service latency).

---

## Observability

- **13 custom Prometheus metrics** including `dicetilt_bet_processing_duration_ms` (histogram, P95 proof), `dicetilt_double_spend_rejections_total`, `dicetilt_active_websocket_connections`, `dicetilt_kafka_dlq_messages_total`
- **Infrastructure exporters:** Redis (`redis_exporter`), Postgres (`postgres-exporter`), Kafka (JMX exporter)
- **Grafana Dashboard:** Four-row layout — Game Floor, Performance Proof, Infrastructure Health, Security & Integrity. Auto-provisioned at boot, no manual setup.

---

## Project Structure

```
DiceTiltClaude/
├── packages/shared-types/        # Zod schemas, Kafka event types, WebSocket enums
├── services/
│   ├── api-gateway/              # Express, WebSocket, Redis, Kafka producer
│   ├── provably-fair/            # Stateless HMAC-SHA256 worker
│   ├── ledger-consumer/          # Kafka → Postgres + Redis Pub/Sub
│   ├── evm-listener/             # EVM deposit event listener
│   └── evm-payout-worker/        # EVM withdrawal signer (isolated)
├── contracts/
│   └── evm/                      # Treasury.sol, Hardhat config, deploy scripts
├── db/init.sql                   # Schema, CHECK constraints, indexes
├── docker/                       # nginx.conf, init-kafka.sh, Dockerfiles
├── frontend/                     # index.html (game UI + PF audit), dashboard.html
├── grafana/                      # Pre-provisioned dashboard JSON
├── prometheus/                   # prometheus.yml
├── tests/
│   ├── unit/                     # Jest: PF crypto, Lua atomicity (10 tests)
│   └── load/                     # k6: WebSocket bet loop, double-spend attack
├── documentation/                # Architecture, sequence diagrams, Kafka topology
└── docker-compose.yml            # 13 services, healthchecks, dependency ordering
```

---

## How to Run

### Prerequisites

- **Docker** (20.10+) and **Docker Compose** (v2+)
- **Node.js 20+** and **pnpm 9+** (optional, for local development and tests)

### Quick Start

```bash
git clone https://github.com/Fennzo/DiceTilt.git
cd DiceTilt
cp .env.example .env
docker compose up -d
docker compose ps   # Wait until all services show healthy
```

Open:
- **Game UI:** http://localhost
- **Demo mode** (pre-funded account): http://localhost/?demo=1
- **Metrics Dashboard:** http://localhost/dashboard.html
- **Grafana:** http://localhost:3001
- **Prometheus:** http://localhost:9090

### Local Development

```bash
pnpm install    # Install workspace dependencies
pnpm build      # Build all packages and services
npx jest --config jest.config.cjs --no-coverage   # Run unit tests (10/10)
pnpm lint       # ESLint
```

### Stopping

```bash
docker compose down
```

---

## Skills Demonstrated

- **Distributed Systems:** Event-driven architecture, Kafka consumer groups, DLQ patterns, pub/sub coordination
- **Financial Systems:** Atomic balance operations, idempotency, double-spend prevention, audit trails
- **Blockchain:** EVM (ethers.js, Solidity), sovereign local test node, Treasury contract lifecycle
- **Security:** EIP-712 wallet auth, JWT, rate limiting, seed commitment scheme, secrets management
- **Cryptography:** Provably fair HMAC-SHA256 scheme with commitment/reveal cycle, client-side verification
- **DevOps:** Docker Compose, healthchecks, dependency ordering, Prometheus/Grafana
- **TypeScript:** Strict mode, pnpm monorepo, shared-types package, Zod validation
- **Testing:** Unit tests (Jest, 10 passing), load tests (k6, 100-VU), integration tests

---

## Production Readiness Notes

- Designed for Ansible deployment with Vault-injected secrets
- MEV protection architecture documented (Jito/Flashbots) for future Trade Router (Rust stub present)
- Event-Driven Ansible (EDA) rulebook documented for alert-driven Kafka broker remediation
- Node.js `cluster` module used in API Gateway for multi-core utilisation
