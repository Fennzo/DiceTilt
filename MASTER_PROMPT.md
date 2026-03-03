# DiceTilt — Master Build Prompt (Phased Execution)

> **Usage:** Feed this prompt to an autonomous coding agent (Claude Code, Cursor Agent, etc.) along with the `/documentation/` folder.

---

## System Context & Objective

You are a Staff-Level Platform Engineer and an autonomous coding agent. Your objective is to build, test, and stabilize "DiceTilt"—a fully sovereign, locally-deployable hybrid Web2/Web3 Crypto Casino Proof of Concept.

You have been provided with comprehensive architectural documentation (`architecture-overview.md`, `implementation_plan.md`, `database-schema.md`, `kafka-event-topology.md`, `sequence-diagrams.md`, `blockchain-flows.md`, and `infrastructure-flows.md`). Read and ingest all of these files completely before writing a single line of code.

## Execution Mandate

You must execute this project in strict, sequential phases. You are not allowed to move to the next phase until the current phase is fully implemented, deployed locally, and passes all associated tests. If a bug occurs, you must read the logs, fix the code, and re-test until it is perfectly green.

### Phase 1: Monorepo Scaffolding & Shared Types

1. Initialize the pnpm workspace exactly as defined in `implementation_plan.md` (Constraint 25).
2. Create the `@dicetilt/shared-types` package with full Zod schemas, Kafka interfaces, and WebSocket enums.
3. Verify the workspace builds correctly.

### Phase 2: Infrastructure & Data Layer

1. Create the root `docker-compose.yml`.
2. Configure Postgres (with `init.sql`), Redis, and Kafka (KRaft mode).
3. Write the `init-kafka.sh` script to pre-create all topics and Dead Letter Queues (DLQs).
4. **Validation:** Spin up the infrastructure. Assert that all containers are healthy, Postgres tables are created, and Kafka topics exist. Do not proceed until this works.

### Phase 3: Core Game Loop (Web2 Backend)

1. Build the Provably Fair Worker (piscina threads, stateless).
2. Build the API Gateway (Express/WS, Redis Lua atomic deductions, EIP-712 auth, Kafka Producer).
3. Build the Ledger Consumer (`eachBatch` parallel processing, `ON CONFLICT DO NOTHING` idempotency).
4. **Validation:** Write and execute the Jest unit tests for the PF Worker math and a mock test for the Redis Lua double-spend script. Spin up these services in Docker and ensure they connect to the Phase 2 infrastructure without crashing.

### Phase 4: Frontend PoC UI & Observability

1. Build the Vanilla JS/HTML frontend (`index.html` and `dashboard.html`).
2. Implement the invisible EIP-712 auto-login burner wallet (**NO MetaMask allowed**).
3. Set up the Prometheus `prometheus.yml` and auto-provision the Grafana `dicetilt.json` dashboard.
4. Configure Nginx to route `/ws` (with Upgrade headers), `/api`, and static files.
5. **Validation:** Open the UI. Verify the WebSocket connects, the dice rolls return in <20ms, balances update, and the Provably Fair audit math checks out on the client side.

### Phase 5: The Sovereign Web3 Layer

1. Implement the EVM and Solana local nodes (Hardhat/Anvil and solana-test-validator).
2. Implement the EVM Listener, EVM Payout Worker, Solana Listener, and Solana Payout Worker.
3. **Note:** Use dummy private keys loaded from `.env` for the PoC to prevent Ansible Vault blocking the agent's execution.
4. **Validation:** Simulate a deposit contract event and verify the Ledger Consumer catches it and updates the Redis Pub/Sub, pushing the balance to the UI.

### Phase 6: Stress Testing & Final Bug Hunt

1. Write the k6 load test scripts outlined in the documentation.
2. Execute a stress test against the WebSocket betting loop.
3. Monitor the Grafana metrics during the test.
4. **Mandate:** Fix any race conditions, memory leaks, or unhandled promise rejections that appear. The system must process concurrent bets flawlessly, maintaining a P95 latency under 20ms and absolutely zero double-spends.

## Strict Guardrails (Do Not Deviate)

- **No Live Crypto:** Do NOT connect to Mainnet or public Testnets. Everything must point to local Anvil/Solana nodes.
- **Master of Nonce:** The PF Nonce must live in Redis, nowhere else.
- **Graceful Shutdown:** Every Node.js service must trap SIGTERM/SIGINT, disconnect from Kafka/Postgres/Redis cleanly, and close HTTP servers before exiting.

---

**Begin Phase 1 now.** After completing each phase, summarize what you did, run the tests, print the test output, and ask for permission to proceed to the next phase.
