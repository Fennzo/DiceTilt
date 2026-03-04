# DiceTilt — System Architecture Overview

**Audience:** Software architects, senior engineers, technical reviewers.

This document is the top-level structural reference for the DiceTilt system. For engineering constraints and business rules, see `implementation_plan.md`. For event message schemas, see `kafka-event-topology.md`. For the data model, see `database-schema.md`. For interaction flows, see `sequence-diagrams.md`, `blockchain-flows.md`, and `infrastructure-flows.md`. For Solana production requirements (commitment levels, ATA handling, USDC vs SOL, RPC infrastructure, and Trade Router context), see `solana-production-notes.md`.

---

## 1. System Context

DiceTilt is a fully sovereign, locally-deployable hybrid Web2/Web3 system. All blockchain nodes run locally — no internet dependency, no real assets required. The recruiter/demo user interacts entirely through a single browser endpoint (`localhost:80`).

```mermaid
graph TD
    User(["Recruiter / Demo User\n(Browser)"])

    subgraph "DiceTilt Platform — Docker Compose Stack"
        DT["All containerised services\n(TypeScript workers, Kafka, Redis, Postgres, Nginx)"]
    end

    subgraph "Local Blockchain Nodes (zero-latency, pre-funded)"
        EVM["Local EVM Node\nHardhat/Anvil  :8545"]
        SOL["Local Solana Validator\nsolana-test-validator  :8899 / :8900"]
    end

    User -->|"HTTP + WebSocket\nlocalhost:80"| DT
    DT <-->|"ethers.js JSON-RPC\ndeposit events · tx signing"| EVM
    DT <-->|"@solana/web3.js JSON-RPC\ndeposit events · tx signing"| SOL
```

---

## 2. Container Architecture (Full Topology)

```mermaid
graph TD
    Client["frontend/index.html\nRecruiter UI"]

    subgraph "API Ingress & Proxy Layer"
        Nginx["Reverse Proxy\nNginx — CORS, WS upgrade, static serve"]
        API["API / Gateway Service\nTypeScript · Express · ws"]
    end

    subgraph "Messaging & Cache Layer"
        Redis[("Redis\nSession · Balances · Nonce · Rate Limiter · Pub/Sub")]
        Kafka["Apache Kafka  KRaft mode\nEvent Bus"]
        Postgres[("PostgreSQL\nACID Ledger")]
    end

    subgraph "Internal Processing Workers"
        PF["Provably Fair Worker\nTypeScript · HMAC-SHA256 engine"]
        Ledger["Ledger Consumer\nTypeScript · Kafka → Postgres"]
        EVMPayout["EVM Payout Worker\nTypeScript · ethers.Wallet"]
        SolPayout["Solana Payout Worker\nTypeScript · treasury keypair"]
    end

    subgraph "Sovereign Web3 — Local EVM"
        EVMListen["EVM Listener Service\nethers.js · event subscription"]
        LocalEth(("Hardhat / Anvil\n:8545"))
        Treasury(("Treasury.sol\nLocal Deploy"))
    end

    subgraph "Sovereign Web3 — Local Solana"
        SolListen["Solana Listener Service\n@solana/web3.js · Program.addEventListener"]
        LocalSol(("solana-test-validator\n:8899 HTTP  :8900 WS"))
        SolTreasury(("Anchor Treasury\nRust / Anchor"))
    end

    subgraph "Observability Layer"
        Prom["Prometheus\nMetrics Engine  :9090"]
        Grafana["Grafana\nPre-Provisioned Dashboard  :3001"]
        RedisExp["Redis Exporter  :9121"]
        PGExp["Postgres Exporter  :9187"]
        KafkaExp["Kafka JMX Exporter  :5556"]
    end

    Client <-->|"HTTP / WebSocket"| Nginx
    Nginx <-->|"/ws  /api  /api/pf/*"| API
    API <-->|"internal — PF_AUTH_TOKEN"| PF

    API <-->|"EVAL Lua — atomic balance + nonce"| Redis
    API <-->|"SUBSCRIBE user:updates:*"| Redis
    API <-->|"internal REST/gRPC"| PF
    API -->|"BetResolved · WithdrawalRequested"| Kafka

    Ledger -->|"consume BetResolved · DepositReceived · WithdrawalCompleted"| Kafka
    Ledger -->|"ON CONFLICT DO NOTHING"| Postgres
    Ledger -->|"SET balance · PUBLISH user:updates:{userId}"| Redis

    EVMListen -->|"subscribe Deposit events"| LocalEth
    LocalEth <--> Treasury
    EVMListen -->|"DepositReceived  chain:ethereum"| Kafka

    SolListen -->|"Program.addEventListener DepositEvent"| LocalSol
    LocalSol <--> SolTreasury
    SolListen -->|"DepositReceived  chain:solana"| Kafka

    EVMPayout -->|"consume WithdrawalRequested · produce WithdrawalCompleted"| Kafka
    EVMPayout -->|"treasury.payout() signed tx"| LocalEth

    SolPayout -->|"consume WithdrawalRequested · produce WithdrawalCompleted"| Kafka
    SolPayout -->|"signed SPL transfer"| LocalSol

    Prom -->|"scrape /metrics"| API
    Prom -->|"scrape /metrics"| PF
    Prom -->|"scrape /metrics"| Ledger
    Prom -->|"scrape"| RedisExp
    Prom -->|"scrape"| PGExp
    Prom -->|"scrape JMX"| KafkaExp
    RedisExp -.->|"queries"| Redis
    PGExp -.->|"queries"| Postgres
    KafkaExp -.->|"JMX"| Kafka
    Grafana -->|"PromQL"| Prom
```

---

## 3. Architectural Layer Breakdown

| Layer | Services | Primary Responsibility |
|---|---|---|
| **Ingress** | Nginx | Single entry point. HTTP/WS routing, CORS headers, WebSocket protocol upgrade (`Upgrade` header injection), static `index.html` serving. |
| **Application** | API Gateway | EIP-712 authentication, JWT issuance, WebSocket session lifecycle, Redis Lua atomic balance and nonce operations, Kafka event production for bets and withdrawals. **WebSocket auth:** JWT is sent as the **first WS frame** (`{ type: "AUTH", token }`) after a bare HTTP 101 upgrade — never in the URL or headers (prevents token logging). A 10-second timer closes unauthenticated sockets. Per-user connection cap: 5. Max frame size: 64 KB. **SUBSCRIBEs** to Redis channel `user:updates:{userId}` — on message, pushes BALANCE_UPDATE or WITHDRAWAL_COMPLETED to the user's WebSocket. Runs as a **Node.js cluster** (one worker per CPU core). The cluster primary serves aggregated Prometheus metrics on internal port 9091 via `prom-client AggregatorRegistry`; worker processes register an IPC handler by constructing `new AggregatorRegistry()` on startup. |
| **Cryptography** | Provably Fair Worker | **Stateless** HMAC-SHA256 engine. All inputs (including server seed) are passed by the API Gateway — the PF Worker never accesses Postgres or Redis. Generates seeds and computes hashes as a pure function. Accessible only via internal `PF_AUTH_TOKEN`. CPU-bound hash work is executed through a `piscina` Worker Threads pool to avoid event-loop blocking under concurrency. |
| **Messaging** | Kafka (KRaft) | Durable async event bus. Decouples the synchronous sub-20ms game loop from async DB settlement, blockchain event processing, and payout execution. |
| **Cache** | Redis | Primary balance and nonce read/write layer via atomic Lua scripts. Session registry with TTL-based revocation. Sliding window rate limiter via ZSET. **Pub/Sub:** Ledger Consumer PUBLISHes to `user:updates:{userId}` after balance/withdrawal updates; API Gateway SUBSCRIBEs and pushes BALANCE_UPDATE / WITHDRAWAL_COMPLETED to WebSocket clients in real time. |
| **Persistence** | PostgreSQL | Canonical ACID ledger. Receives idempotent `ON CONFLICT DO NOTHING` inserts from the Ledger Consumer. Source of truth for balance hydration on Redis cache miss. |
| **Settlement** | Ledger Consumer | Kafka consumer writing `BetResolved`, `DepositReceived`, and `WithdrawalCompleted` events to Postgres. Uses `eachBatch` with per-`user_id` grouping and `Promise.all` across groups so cross-user writes run in parallel while preserving per-user ordering. Routes failed messages to **per-topic DLQs** (`BetResolved-DLQ`, `DepositReceived-DLQ`, `WithdrawalCompleted-DLQ`) after exhausting retries. After updating Postgres and Redis, **PUBLISHes** to Redis channel `user:updates:{userId}` so the API Gateway can push real-time BALANCE_UPDATE / WITHDRAWAL_COMPLETED to WebSocket clients. |
| **Blockchain (EVM)** | EVM Listener, EVM Payout, Hardhat/Anvil, Treasury.sol | Local Ethereum chain. Event-driven deposit detection and isolated transaction signing for withdrawals. Private key never leaves the Payout Worker container. |
| **Blockchain (Solana)** | Solana Listener, Solana Payout, solana-test-validator, Anchor Treasury | *(Architecture stub — not yet implemented in this PoC. EVM layer is fully functional.)* Local Solana chain design mirrors the EVM layer: parallel deposit and withdrawal pipeline, completely independent of EVM. Multi-stage Docker build: Rust stage compiles Anchor program; Solana stage deploys it. |
| **Observability** | Prometheus, Grafana, 3 exporters | Pull-based metrics collection from all TypeScript services (`prom-client`) and infrastructure exporters. Pre-provisioned Grafana dashboard auto-loads at boot. |
| **Automation** | Ansible, Ansible Vault *(production only)*, EDA | Deployment automation, encrypted secret management for payout private keys (production — PoC uses deterministic keys from `.env`), automated Kafka broker remediation via Prometheus alerting → EDA rulebook. |

### 3.1 Prometheus Metrics Prefix Convention

All TypeScript services instrument default Node.js metrics via `prom-client`. The prefix differs by service:

| Service | Default metrics prefix | Custom metrics prefix |
|---|---|---|
| API Gateway | `dicetilt_` | `dicetilt_` (e.g. `dicetilt_bets_total`) |
| Provably Fair Worker | `dicetilt_pf_` | `dicetilt_` (e.g. `dicetilt_provably_fair_hash_duration_ms`) |
| Ledger Consumer | `dicetilt_` | `dicetilt_` (e.g. `dicetilt_kafka_dlq_messages_total`) |
| EVM Listener | `dicetilt_` | `dicetilt_` (e.g. `dicetilt_on_chain_deposits_total`) |
| EVM Payout Worker | `dicetilt_` | `dicetilt_` (e.g. `dicetilt_withdrawal_completions_total`) |

The PF Worker uses `prefix: 'dicetilt_pf_'` for its **default Node.js runtime metrics** (heap, event loop lag, etc.) to distinguish them from the API Gateway's runtime metrics in Grafana. The PF Worker's **custom metric** (`dicetilt_provably_fair_hash_duration_ms`) does not use this prefix — it is named explicitly and appears without it.

### 3.2 Runtime Concurrency Model (TypeScript on Node.js)

- TypeScript defines source language and type safety; runtime concurrency characteristics come from Node.js (`worker_threads`, `cluster`, libuv event loop).
- Provably Fair hash computation is CPU-bound and therefore executed in a `piscina` Worker Threads pool.
- API Gateway uses Node.js `cluster` to run one worker process per CPU core.
- Kafka `BetResolved` topic uses 3 partitions; with 3 Ledger Consumer replicas in the same consumer group, this yields 3 parallel partition processors.
- Ledger Consumer processes batches with per-user grouping and parallel writes across users, preserving per-user order while increasing throughput.

### 3.3 Redis Pub/Sub — Real-Time Balance & Withdrawal Updates

The Ledger Consumer and API Gateway run in separate processes. The API Gateway holds the active WebSocket connection; the Ledger Consumer has no direct way to notify it. **Redis Pub/Sub** closes this gap:

1. **Ledger Consumer** — After processing each event, PUBLISHes to `user:updates:{userId}`:
   - `DepositReceived` → one message: `{ type: 'BALANCE_UPDATE', chain, currency, balance }`
   - `WithdrawalCompleted` → **two** messages in sequence: first `{ type: 'BALANCE_UPDATE', ... }` (so a reconnected client refreshes immediately), then `{ type: 'WITHDRAWAL_COMPLETED', withdrawalId, chain, currency, txHash, amount }` (so the UI can dismiss the "pending" state).
2. **API Gateway** — **SUBSCRIBE** to `user:updates:*` (pattern subscription) or per-user channels. On message, look up the user's WebSocket from the in-memory session map and push `BALANCE_UPDATE` or `WITHDRAWAL_COMPLETED` to the browser.

Without this, the user's balance would not update after a deposit until they place a bet or refresh the page — breaking the real-time demo experience.

---

## 4. Service Responsibility Matrix

| Service | Language | Produces (Kafka) | Consumes (Kafka) | Key Dependencies |
|---|---|---|---|---|
| API Gateway | TypeScript | `BetResolved`, `WithdrawalRequested` | — | Redis (Lua, Pub/Sub), PF Worker, Kafka, Postgres (hydration) |
| Provably Fair Worker | TypeScript | — | — | None (internal gRPC/HTTP only) |
| Ledger Consumer | TypeScript | `BetResolved-DLQ` *(on failure)* | `BetResolved`, `DepositReceived`, `WithdrawalCompleted` | PostgreSQL, Kafka, Redis |
| EVM Listener | TypeScript | `DepositReceived` (`chain: ethereum`) | — | Kafka, Hardhat/Anvil |
| EVM Payout Worker | TypeScript | `WithdrawalCompleted` (`chain: ethereum`) | `WithdrawalRequested` (`chain: ethereum`) | Kafka, Hardhat/Anvil, `.env` (PoC) / Ansible Vault (prod) |
| Solana Listener *(stub)* | TypeScript | `DepositReceived` (`chain: solana`) | — | Kafka, solana-test-validator |
| Solana Payout Worker *(stub)* | TypeScript | `WithdrawalCompleted` (`chain: solana`) | `WithdrawalRequested` (`chain: solana`) | Kafka, solana-test-validator, `.env` (PoC) / Ansible Vault (prod) |
| Trade Router *(stub)* | Rust | `TradeExecuted` *(future)* | — | *(Production: Jito, Jupiter; Rust selected for Tokio multi-thread runtime to support MEV path computation at parallelism levels unsuitable for Node.js event-loop workers.)* |

---

## 5. Port Reference

| Service | Internal Port | Host-Exposed Port | Protocol | Notes |
|---|---|---|---|---|
| Nginx | 80 | **80** | HTTP, WebSocket | Primary recruiter entry point |
| API Gateway (app) | 3000 | **3000** | HTTP, WebSocket | Express + WebSocket. Also exposed on host port 3000 for direct load testing (bypasses Nginx for accurate sub-20ms SLO measurement) |
| API Gateway (metrics) | 9091 | — | HTTP | Internal only. The cluster primary serves aggregated Prometheus metrics here via `prom-client AggregatorRegistry.clusterMetrics()`. Prometheus scrapes `:9091/metrics`, not `:3000`. |
| Provably Fair Worker | 3001 | — | HTTP | Internal only; protected by `PF_AUTH_TOKEN` |
| EVM Listener | 3010 | — | HTTP | Internal only; `/metrics` and `/health` endpoints |
| EVM Payout Worker | 3020 | — | HTTP | Internal only; `/metrics` and `/health` endpoints |
| Redis | 6379 | **6380** (debug only) | Redis Protocol | Internal port 6379; host port 6380 exposed for local debugging (`redis-cli -p 6380`). **CRITICAL:** This port has NO authentication. Never expose it on any networked environment. For local debugging, ensure your host machine is not accessible from any network or enable auth. |
| PostgreSQL | 5432 | — | TCP | Internal only |
| Kafka (KRaft) | 29092 | — | Kafka Protocol | Internal broker listener |
| Hardhat / Anvil | 8545 | **8545** | HTTP + WS JSON-RPC | Exposed for frontend burner wallet signing |
| Solana Validator | 8899 / 8900 | **8899 / 8900** | HTTP / WS JSON-RPC | Exposed for frontend Solana signing |
| Prometheus | 9090 | **9090** | HTTP | Direct metric access |
| Grafana | 3000 (internal) | **3001** | HTTP | Recruiter dashboard |
| Redis Exporter | 9121 | — | HTTP (Prometheus scrape) | Internal only |
| Postgres Exporter | 9187 | — | HTTP (Prometheus scrape) | Internal only |
| Kafka JMX Exporter | 5556 | — | HTTP (Prometheus scrape) | Internal only |

---

## 6. Docker Network Topology

All services share a single `backend-net` bridge network. External access is controlled exclusively by which container ports are published to the host — no internal service ports are reachable from the host unless explicitly mapped.

```mermaid
graph LR
    subgraph "Host Machine (published ports)"
        Browser["Browser\n:80"]
        DevAPI["Direct API (load tests)\n:3000"]
        GrafanaHost["Grafana\n:3001"]
        PromHost["Prometheus\n:9090"]
        EVMHost["Hardhat/Anvil\n:8545"]
        RedisDebug["Redis (debug only)\n:6380"]
    end

    subgraph "backend-net — single Docker bridge network"
        Nginx["Nginx\n(host:80 → container:80)"]
        API["API Gateway\n(host:3000 → container:3000)\nMetrics aggregator: internal :9091"]
        PF["PF Worker\n(internal :3001)"]
        Redis["Redis\n(internal :6379; host:6380 for debug)"]
        Kafka["Kafka\n(internal :29092)"]
        Postgres["PostgreSQL\n(internal :5432)"]
        Ledger["Ledger Consumer\n(internal :3030)"]
        EVMListen["EVM Listener\n(internal :3010)"]
        EVMPay["EVM Payout Worker\n— holds private key — (internal :3020)"]
        SolListen["Solana Listener *(stub)*"]
        SolPay["Solana Payout Worker *(stub)*"]
        Prom["Prometheus\n(host:9090 → container:9090)"]
        Grafana["Grafana\n(host:3001 → container:3000)"]
    end

    Browser --> Nginx
    DevAPI --> API
    GrafanaHost --> Grafana
    PromHost --> Prom
    EVMHost -->|"JSON-RPC"| API
    RedisDebug -.->|"debug only"| Redis

    Nginx --> API

    API --> Redis
    API --> Kafka
    API --> PF

    Ledger --> Kafka
    Ledger --> Postgres
    Ledger --> Redis

    EVMListen --> Kafka
    SolListen --> Kafka
    EVMPay --> Kafka
    SolPay --> Kafka

    Prom -->|":9091/metrics (cluster aggregated)"| API
    Prom --> PF
    Prom --> Ledger
    Prom --> EVMListen
    Prom --> EVMPay

    Grafana --> Prom
```

> **Security note (PoC):** The payout workers (`EVMPay`, `SolPay`) have no published host ports and receive no inbound routes from Nginx. Their only communication is outbound Kafka consumption and outbound blockchain RPC calls. In the PoC, private keys are deterministic Hardhat/Solana test keys loaded from `.env` (safe — local chain, no real value). **Production deployments MUST enforce strict network isolation between the ingress tier and the signing tier.** The signing tier (payout workers) must be placed on a separate network segment with no direct ingress routes; egress-only rules limited to blockchain RPC and Kafka; secure key injection via vaults (Ansible Vault, HashiCorp Vault, AWS Secrets Manager, etc.); and additional controls such as network policies, separate VPCs/VNets, or air-gapped environments depending on asset value.
>
> **Note on Redis host port 6380:** Redis is published on host port `6380` for local debugging (e.g., `redis-cli -p 6380`). No authentication is configured on this debug port. It should be removed or firewalled in any non-local deployment.
