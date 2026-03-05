# DiceTilt — Infrastructure & Operational Flows

**Audience:** Platform engineers, DevOps, software architects.

This document covers system-level operational flows: Docker startup ordering, service health checks, graceful shutdown, DLQ handling, blockchain listener resilience, observability metrics collection, and Event-Driven Ansible (EDA) automated remediation.

---

## Flow Index

| # | Flow |
|---|---|
| 1 | Docker Startup Dependency Ordering |
| 2 | Service Startup Sequence (Ordered) |
| 3 | Container Health Check Specifications |
| 4 | Ledger Consumer — DLQ Failure and Recovery |
| 5 | Observability Metrics Collection Pipeline |
| 6 | Grafana Dashboard Auto-Provisioning |
| 7 | Event-Driven Ansible (EDA) — Kafka Broker Remediation |
| 8 | Graceful SIGTERM Shutdown — All TypeScript Services |

---

## Flow 1 — Docker Startup Dependency Ordering

No TypeScript service may attempt to boot until its data/messaging dependencies pass their health checks. All `depends_on` entries use `condition: service_healthy`.

```mermaid
flowchart TD
    PG["PostgreSQL — Healthcheck: pg_isready"]
    Redis["Redis — Healthcheck: redis-cli ping"]
    Kafka["Kafka KRaft — Healthcheck: kafka-topics.sh list"]
    KafkaInit["Kafka Init Container — init-kafka.sh — creates all topics"]
    Nginx["Nginx — Healthcheck: curl /health"]
    PF["PF Worker"]
    API["API Gateway"]
    Ledger["Ledger Consumer"]
    EVMDeploy["evm-deploy — deploy Treasury.sol + fund 100 ETH — outputs TREASURY_CONTRACT_ADDRESS"]
    EVMListen["EVM Listener"]
    SolListen["Solana Listener"]
    EVMPay["EVM Payout Worker"]
    SolPay["Solana Payout Worker"]
    Anvil["Hardhat/Anvil — Healthcheck: eth_blockNumber JSON-RPC"]
    SolVal["Solana Validator — Healthcheck: getHealth RPC"]
    Prom["Prometheus"]
    Grafana["Grafana"]

    PG --> API
    PG --> Ledger
    PG --> EVMListen
    Redis --> API
    Redis --> Ledger
    Kafka --> KafkaInit
    KafkaInit --> API
    KafkaInit --> Ledger
    KafkaInit --> EVMListen
    KafkaInit --> SolListen
    KafkaInit --> EVMPay
    KafkaInit --> SolPay
    Anvil --> EVMDeploy
    EVMDeploy --> EVMListen
    EVMDeploy --> EVMPay
    Anvil --> EVMListen
    Anvil --> EVMPay
    SolVal --> SolListen
    SolVal --> SolPay
    PF --> API
    API --> Nginx
    API --> Prom
    PF --> Prom
    Prom --> Grafana
```

> **Critical constraint (Constraint 15):** TypeScript services connect to Redis, Postgres, and Kafka on boot. If these are not ready, the connection attempt throws and the process exits. `condition: service_healthy` prevents this race condition entirely.
>
> **`evm-deploy` service:** The `evm-deploy` service is the container built from `docker/evm-deploy.Dockerfile`; the Anvil node is exposed as the Docker Compose service named `evm-node`. The `evm-deploy.sh` entrypoint wraps the Hardhat deployment: it runs `hardhat run scripts/deploy.js`, captures the deployed address from stdout with `tail -1`, and writes it to the shared Docker volume `treasury-addr`. The deploy script deploys `Treasury.sol`, immediately funds it with 100 ETH from the Hardhat deployer account (account #0, pre-funded by Anvil), and outputs the contract address as the **last stdout line**. The EVM Listener and EVM Payout Worker mount `treasury-addr` read-only — this is how `TREASURY_CONTRACT_ADDRESS` is propagated without hardcoding. On chain reset (Docker restart), the deploy + fund runs automatically. If the chain was not reset, the script exits early and does not re-fund.
>
> **Network namespace sharing:** `evm-deploy` uses `network_mode: "service:evm-node"`, sharing the Anvil container's network namespace. This means the deploy script connects to `http://127.0.0.1:8545` (loopback) rather than the Docker DNS name `evm-node`. This avoids network configuration complexity for a one-shot container and ensures zero-latency access to Anvil.

---

## Flow 2 — Service Startup Sequence (Ordered)

```mermaid
sequenceDiagram
    participant DC as Docker Compose Orchestrator
    participant PG as PostgreSQL
    participant Redis as Redis
    participant Kafka as Kafka (KRaft)
    participant KI as init-kafka.sh
    participant Anvil as evm-node (Anvil)
    participant EVMDeploy as evm-deploy
    participant SolVal as Solana Validator
    participant API as API Gateway
    participant PF as PF Worker
    participant Ledger as Ledger Consumer
    participant EL as EVM Listener
    participant SL as Solana Listener
    participant EPW as EVM Payout Worker
    participant SPW as Solana Payout Worker
    participant Nginx as Nginx
    participant Prom as Prometheus
    participant Grafana as Grafana

    DC->>PG: start container
    PG->>PG: run /docker-entrypoint-initdb.d/init.sql
    PG-->>DC: healthcheck: pg_isready → OK

    DC->>Redis: start container
    Redis-->>DC: healthcheck: redis-cli ping → PONG

    DC->>Kafka: start container (KRaft mode — no Zookeeper)
    Kafka->>Kafka: format storage with KAFKA_CLUSTER_ID
    Kafka-->>DC: healthcheck: kafka-topics.sh --list → exit 0

    DC->>KI: run init-kafka.sh (depends_on: kafka healthy)
    KI->>Kafka: kafka-topics.sh --create BetResolved, DepositReceived, WithdrawalRequested, WithdrawalCompleted, TradeExecuted, BetResolved-DLQ, DepositReceived-DLQ, WithdrawalCompleted-DLQ
    Kafka-->>KI: topics created
    DC-->>KI: exit 0 (init container completes)

    DC->>Anvil: start evm-node (Anvil, pre-funded accounts)
    Anvil-->>DC: healthcheck: eth_blockNumber → block 1

    DC->>EVMDeploy: start evm-deploy (depends_on: evm-node healthy)
    EVMDeploy->>Anvil: hardhat run scripts/deploy.js — deploy Treasury.sol
    Anvil-->>EVMDeploy: contract deployed at 0x5FbDB...
    EVMDeploy->>Anvil: deployer.sendTransaction({ to: treasury, value: 100 ETH })
    Anvil-->>EVMDeploy: fund tx confirmed
    EVMDeploy->>DC: stdout last line = '0x5FbDB...' (parsed by evm-deploy.sh via tail -1)
    Note over EVMDeploy: TREASURY_CONTRACT_ADDRESS written — container exits 0

    DC->>SolVal: start solana-test-validator (multi-stage: Rust compile → validator boot)
    SolVal->>SolVal: deploy Anchor Treasury program --bpf-program
    SolVal-->>DC: healthcheck: getHealth → 'ok'

    DC->>PF: start PF Worker (depends_on: none — stateless, no external connections)
    DC->>API: start API Gateway (depends_on: PG healthy, Redis healthy, Kafka init complete, PF healthy)
    DC->>Ledger: start Ledger Consumer (depends_on: PG healthy, Redis healthy, Kafka init complete)
    DC->>EL: start EVM Listener (depends_on: evm-deploy complete, Anvil healthy, PG healthy, Kafka init complete)
    DC->>SL: start Solana Listener (depends_on: SolVal healthy, Kafka init complete)
    DC->>EPW: start EVM Payout Worker (depends_on: evm-deploy complete, Anvil healthy, Kafka init complete)
    DC->>SPW: start Solana Payout Worker (depends_on: SolVal healthy, Kafka init complete)

    DC->>Nginx: start Nginx (depends_on: API healthy)
    DC->>Prom: start Prometheus (depends_on: API healthy, PF healthy)
    DC->>Grafana: start Grafana (depends_on: Prom healthy)

    Note over Nginx, Grafana: System fully ready — recruiter opens localhost:80
```

---

## Flow 3 — Container Health Check Specifications

| Service | Health Check Command | Interval | Timeout | Retries | Start Period |
|---|---|---|---|---|---|
| PostgreSQL | `pg_isready -U ${POSTGRES_USER} -d ${POSTGRES_DB}` | 5s | 5s | 5 | 10s |
| Redis | `redis-cli ping` | 5s | 3s | 5 | 5s |
| Kafka | `kafka-topics.sh --bootstrap-server localhost:29092 --list` | 10s | 10s | 10 | 30s |
| Hardhat/Anvil | `cast block-number --rpc-url http://localhost:8545` | 5s | 5s | 10 | 10s |
| Solana Validator | `curl -sf -X POST -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' http://localhost:8899` | 5s | 5s | 10 | 60s |
| API Gateway | `wget -qO- http://localhost:3000/health` | 10s | 5s | 3 | 15s |
| PF Worker | `wget -qO- http://localhost:3001/health` | 10s | 5s | 3 | 10s |
| EVM Listener | `wget -qO- http://localhost:3010/health` | 10s | 5s | 3 | 15s |
| EVM Payout Worker | `wget -qO- http://localhost:3020/health` | 10s | 5s | 3 | 10s |
| Ledger Consumer | `wget -qO- http://localhost:3030/health` | 10s | 5s | 3 | 15s |
| Nginx | `curl -sf http://localhost:80/health` | 10s | 5s | 3 | 5s |
| Prometheus | `wget -qO- http://localhost:9090/-/healthy` | 10s | 5s | 3 | 10s |
| Grafana | `wget -qO- http://localhost:3000/api/health` | 10s | 5s | 5 | 15s |

> **Start Period:** Docker does not count health check failures during the start period. This allows services with slow initialisation (Kafka formatting, Solana compilation) to fully boot before failing the health check and triggering a container restart.
>
> **Note on Kafka port:** The internal Kafka listener is `29092` (not the standard `9092`). The `9093` port is used for the internal KRaft controller — it is never addressed by application services.
>
> **Note on Anvil health check:** Uses the Foundry `cast` CLI (`cast block-number`) rather than a raw `curl` JSON-RPC call. `cast` is available inside the `ghcr.io/foundry-rs/foundry` container image used for the EVM node.

---

## Flow 4 — Ledger Consumer: DLQ Failure and Recovery

```mermaid
sequenceDiagram
    participant Kafka as Kafka (BetResolved)
    participant LC as Ledger Consumer
    participant PG as PostgreSQL
    participant DLQ as Kafka (BetResolved-DLQ)
    participant Prom as Prometheus
    participant Grafana as Grafana
    participant Alert as EDA / Alertmanager

    LC->>Kafka: fetch message batch (autoCommit: false)
    LC->>LC: parse payload → BetResolvedEvent

    loop Up to MAX_RETRIES (e.g., 3)
        LC->>PG: INSERT INTO transactions ON CONFLICT (bet_id) DO NOTHING
        alt Postgres unavailable
            PG-->>LC: ECONNREFUSED
            LC->>LC: wait exponential backoff (1s, 2s, 4s)
        else Payload malformed (Zod validation fail)
            LC->>LC: skip retries — unrecoverable error
        else Success
            PG-->>LC: insert acknowledged
            LC->>Kafka: commitOffsets (manual)
            Note over LC: Happy path — exit loop
        end
    end

    Note over LC: All retries exhausted OR unrecoverable error
    LC->>DLQ: produce DeadLetterMessage { original_payload, error, retry_count, failed_at }
    LC->>Kafka: commitOffsets for original message (avoid infinite re-delivery loop)
    LC->>Prom: increment dicetilt_kafka_dlq_messages_total{source_topic='BetResolved'}

    Prom->>Alert: scrape detects DLQ count > 0
    Alert->>Grafana: alert fires on Security and Integrity dashboard row
    Alert->>Alert: EDA rulebook triggers notification / auto-remediation

    Note over LC: Consumer continues processing next messages — does NOT crash
```

---

## Flow 5 — Observability Metrics Collection Pipeline

```mermaid
sequenceDiagram
    participant API as API Gateway (prom-client)
    participant PF as PF Worker (prom-client)
    participant LC as Ledger Consumer (prom-client)
    participant RedisExp as Redis Exporter
    participant PGExp as Postgres Exporter
    participant KafkaExp as Kafka JMX Exporter
    participant Prom as Prometheus
    participant Grafana as Grafana
    participant Redis as Redis
    participant PG as PostgreSQL
    participant Kafka as Kafka

    Note over Prom: Every 15s scrape interval (configurable in prometheus.yml)

    par Scrape TypeScript services
        Prom->>API: GET :9091/metrics (cluster primary — aggregates all worker metrics via prom-client AggregatorRegistry)
        API-->>Prom: dicetilt_bets_total, dicetilt_bet_processing_duration_ms, dicetilt_active_websocket_connections, dicetilt_double_spend_rejections_total, ...
    and
        Prom->>PF: GET /metrics
        PF-->>Prom: dicetilt_provably_fair_hash_duration_ms, ...
    and
        Prom->>LC: GET /metrics
        LC-->>Prom: dicetilt_kafka_dlq_messages_total, ...
    end

    par Scrape infrastructure exporters
        RedisExp->>Redis: INFO all
        Redis-->>RedisExp: keyspace hits/misses, memory_used, evicted_keys, connected_clients
        Prom->>RedisExp: GET /metrics
        RedisExp-->>Prom: redis_keyspace_hits_total, redis_memory_used_bytes, ...
    and
        PGExp->>PG: SELECT pg_stat_activity, pg_stat_statements
        PG-->>PGExp: active connections, query duration, cache hit ratio
        Prom->>PGExp: GET /metrics
        PGExp-->>Prom: pg_stat_activity_count, pg_stat_statements_mean_exec_time_seconds, ...
    and
        KafkaExp->>Kafka: JMX query kafka.server:type=BrokerTopicMetrics, kafka.consumer:type=ConsumerFetcherManager
        Kafka-->>KafkaExp: MessagesInPerSec, BytesInPerSec, consumer_lag_records_count
        Prom->>KafkaExp: GET /metrics
        KafkaExp-->>Prom: kafka_consumergroup_lag, kafka_topic_partition_current_offset, ...
    end

    Note over Prom: Store all time-series data in local TSDB

    Grafana->>Prom: PromQL queries on dashboard refresh (every 5s by default)
    Prom-->>Grafana: time-series data points
    Grafana->>Grafana: render panels (histograms, gauges, counters, time series)
    Note over Grafana: Recruiter sees live dashboard with no manual setup
```

---

## Flow 6 — Grafana Dashboard Auto-Provisioning

```mermaid
sequenceDiagram
    participant DC as Docker Compose
    participant Grafana as Grafana Container
    participant VolDS as Volume: /grafana/provisioning/datasources/
    participant VolDB as Volume: /grafana/provisioning/dashboards/
    participant VolJSON as Volume: /grafana/dashboards/dicetilt.json
    participant Prom as Prometheus

    DC->>Grafana: start container with volume mounts
    Grafana->>VolDS: read prometheus.yaml datasource definition
    Note over VolDS: url: http://prometheus:9090, access: proxy, isDefault: true
    Grafana->>Prom: verify datasource connectivity
    Prom-->>Grafana: HTTP 200 OK

    Grafana->>VolDB: read dashboards.yaml provider definition
    Note over VolDB: path: /var/lib/grafana/dashboards, disableDeletion: false
    Grafana->>VolJSON: load dicetilt.json dashboard definition
    Grafana->>Grafana: import dashboard — 4 rows, 20+ panels provisioned

    Note over Grafana: Dashboard available at localhost:3001 immediately on boot
    Note over Grafana: Zero manual steps required — no clicking Add datasource or Import dashboard
    Note over Grafana: GF_SECURITY_ALLOW_EMBEDDING=true + GF_AUTH_ANONYMOUS_ENABLED=true → iframe in dashboard.html loads without login
```

---

## Flow 7 — Event-Driven Ansible (EDA): Kafka Broker Remediation

> **⚠️ Architectural design only — not implemented in the PoC.** No EDA controller, Alertmanager, or Ansible playbook exists in `docker-compose.yml`. This flow documents the intended production remediation architecture.

When Prometheus detects a Kafka broker health degradation, an alert fires. The EDA controller receives the alert and automatically executes a remediation playbook to restart the broker.

```mermaid
sequenceDiagram
    participant Kafka as Kafka Broker
    participant KafkaExp as Kafka JMX Exporter
    participant Prom as Prometheus
    participant AM as Alertmanager
    participant EDA as EDA Controller (ansible-rulebook)
    participant Ansible as Ansible Playbook (kafka_health.yml)
    participant DC as Docker Compose / Container Runtime

    Note over Kafka: Broker becomes unresponsive (OOM, crash, etc.)
    KafkaExp->>Kafka: JMX query — no response
    KafkaExp-->>Prom: kafka_broker_state = 0 (not active)

    Prom->>Prom: evaluate alert rule: kafka_broker_state == 0 for > 30s
    Prom->>AM: fire alert: KafkaBrokerDown { severity: critical, broker: 'kafka:29092' }
    AM->>EDA: POST /alerts (ansible.eda.alertmanager source plugin listening)

    EDA->>EDA: evaluate rulebook condition: alert.name == 'KafkaBrokerDown'
    EDA->>Ansible: trigger kafka_health.yml playbook
    Ansible->>DC: docker restart kafka
    DC->>Kafka: container restarts — KRaft storage already formatted
    Kafka-->>DC: healthcheck: kafka-topics.sh --list → exit 0

    Ansible->>EDA: playbook complete — success
    EDA->>EDA: log remediation event

    Prom->>Prom: kafka_broker_state = 1 — alert resolves
    AM->>AM: send resolved notification
    Note over EDA: No human intervention required for transient broker failure
```

---

## Flow 8 — Graceful SIGTERM Shutdown (All TypeScript Services)

Every TypeScript service must handle `SIGINT` and `SIGTERM` without losing in-flight work or leaving dangling connections. This is critical for zero-downtime container restarts (e.g., during `docker-compose up --build` redeploys).

```mermaid
sequenceDiagram
    participant DC as Docker / OS
    participant Service as TypeScript Service (any)
    participant WS as Active WebSocket Connections
    participant Kafka as Kafka Client (kafkajs)
    participant PG as PostgreSQL Pool (pg)
    participant Redis as Redis Pool (ioredis)

    DC->>Service: SIGTERM signal (or SIGINT on Ctrl+C)
    Service->>Service: process.on('SIGTERM', gracefulShutdown) handler fires

    Note over Service: Phase 1 — Stop accepting new traffic
    Service->>Service: httpServer.close() — stop accepting new HTTP/WS connections
    Service->>WS: send SESSION_REVOKED or close frame to all active WebSocket clients
    WS-->>Service: connections acknowledged / closed

    Note over Service: Phase 2 — Drain in-flight Kafka work
    Service->>Kafka: consumer.pause() — stop fetching new messages
    Service->>Service: wait for current eachBatch() handler to complete
    Service->>Kafka: consumer.commitOffsets() — commit current partition offsets
    Service->>Kafka: consumer.disconnect() — leave consumer group gracefully
    Service->>Kafka: producer.disconnect() — flush pending sends

    Note over Service: Phase 3 — Close database connections
    Service->>PG: pool.end() — wait for active queries to complete, then close all connections
    Service->>Redis: redis.quit() — send QUIT command, await acknowledgement

    Note over Service: Phase 4 — Exit cleanly
    Service->>Service: process.exit(0)

    DC-->>DC: container stops with exit code 0 (not 137 / killed)
    Note over DC: Docker Compose marks service as stopped cleanly
```

> **Why this matters:** A forced kill (`SIGKILL` / exit code 137) can leave Kafka consumer group partitions in an unclean state, delaying rebalance and causing message processing gaps. A graceful shutdown commits offsets, leaves the consumer group cleanly, and allows the Kafka coordinator to immediately reassign partitions — minimising settlement lag during deployments.
