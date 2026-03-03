# DiceTilt — Project Overview for Recruiters

> **Purpose:** A portfolio project demonstrating full-stack engineering, system design, and blockchain integration for roles in software development, product engineering, and technical leadership.

---

## What Is DiceTilt?

**DiceTilt** is a working prototype of a crypto-powered dice game platform. It combines traditional web technology with blockchain to create a fast, transparent, and auditable gaming experience. The project was built to showcase end-to-end system design—from user interface to database to blockchain—in a single, runnable demo.

---

## Why This Project Matters

### Real-World Problem Solved

Online gaming platforms must handle money safely, process transactions quickly, and prove that outcomes are fair. DiceTilt addresses all three:

1. **Safety** — User balances and bets are protected against fraud through careful, mathematically-proven design. Concurrent attacks (multiple simultaneous bets attempting to overdraw a balance) are blocked at the database level.
2. **Speed** — The system processes each bet in under 20 milliseconds end-to-end. This was independently verified under load: **148,743 bets in 60 seconds** with zero errors and a P95 latency of **17.9 ms**.
3. **Fairness** — Every bet result can be mathematically verified by the user at any time. The server commits to a secret before the game starts, then reveals it afterwards so the player can confirm no manipulation occurred.

### Multi-Chain Architecture

The platform is designed for two major blockchain ecosystems—Ethereum and Solana. The Ethereum layer is fully implemented and running. The Solana layer is architecturally designed and documented, ready for implementation.

---

## Key Achievements

| Achievement | What It Means |
|-------------|---------------|
| **Proven Performance** | Measured 17.9ms P95 latency at 2,479 bets/second under 100-user concurrent load. |
| **Full-Stack Implementation** | Built everything from database to user interface, including blockchain integration. |
| **Microservices Architecture** | Split into 5 independent services that communicate via a message queue—each can be scaled or replaced without touching the others. |
| **Event-Driven Design** | Uses Apache Kafka so different parts of the system communicate reliably and asynchronously, even under load. |
| **Production-Oriented Practices** | Live monitoring dashboards, health checks, graceful shutdown, error recovery, and secrets management. |
| **Zero-Friction Demo** | One command starts all 13 containers. No cloud accounts, no wallet setup, no API keys needed. |

---

## What You Can See in a Demo

1. **Instant Play** — Open the app and you're playing immediately. No wallet setup or blockchain wait times. Each new user automatically gets a demo balance.
2. **Live Metrics** — A Grafana dashboard shows active connections, bets per second, latency histograms, and system health in real time.
3. **Provably Fair Audit** — Users can verify that each dice roll was generated honestly. After clicking "Rotate Seed & Verify," two hash values appear—one from the server and one recomputed by the browser. They should match exactly, proving no manipulation.
4. **Deposit & Withdrawal** — In demo mode (`/?demo=1`), users can trigger an on-chain deposit from a pre-funded Ethereum account and see the balance update in real time via WebSocket.

---

## Skills Demonstrated

### Technical Skills

- **Backend Development** — REST APIs, WebSockets, databases, caching, and message queues
- **Blockchain Integration** — Smart contracts, deposits, and withdrawals on Ethereum
- **System Design** — Microservices, event-driven flows, fault isolation, and concurrent-access safety
- **DevOps & Infrastructure** — Containerisation, monitoring, observability dashboards, and health checks
- **Security & Reliability** — Cryptographic authentication, input validation, rate limiting, and abuse prevention

### Soft Skills

- **End-to-End Ownership** — Designed, implemented, tested, and documented the full system
- **Documentation** — Architecture diagrams, database schemas, sequence diagrams, and implementation plans
- **Attention to Detail** — Addressed edge cases, race conditions, and failure scenarios
- **User-Centric Design** — Prioritised a smooth, no-friction experience for demos

---

## Project Scope

- **13 containers** running together (API, game logic, database, Kafka, Redis, blockchain nodes, payout workers, monitoring)
- **5 active TypeScript microservices** with a sixth Solana layer architecturally designed
- **Full documentation** including architecture diagrams, database schemas, and event flow diagrams
- **Automated testing** — unit tests for core cryptographic logic and k6 load tests for performance verification

---

## How to Run

### What You Need

- **Docker Desktop** installed on your computer ([Download Docker](https://www.docker.com/products/docker-desktop/))
- A terminal or command prompt

### Step-by-Step Instructions

1. **Clone the project**:
   ```bash
   git clone https://github.com/Fennzo/DiceTilt.git
   cd DiceTilt
   ```

2. **Create the environment file**:
   - **Windows (PowerShell):** `Copy-Item .env.example .env`
   - **Mac/Linux:** `cp .env.example .env`
   - The default values work as-is—no setup or API keys required.

3. **Start the application**:
   ```bash
   docker compose up -d
   ```
   The first run may take 2–5 minutes while everything downloads and starts.

4. **Wait for services to be ready** (about 1–2 minutes after startup):
   ```bash
   docker compose ps
   ```
   When all services show as healthy, you're ready.

5. **Open the app in your browser**:
   - **Game:** http://localhost
   - **Metrics Dashboard:** http://localhost/dashboard.html
   - **Grafana (charts):** http://localhost:3001

6. **Play immediately** — no wallet or blockchain setup. Each user starts with 10 ETH for demo play.
   - For deposit testing: use http://localhost/?demo=1 (pre-funded demo account).

### To Stop the Application

```bash
docker compose down
```

---

## Summary

DiceTilt is a proof-of-concept that demonstrates the ability to design and build a complex, multi-component system with real financial and blockchain constraints. It shows proficiency in backend engineering, system architecture, blockchain integration, and production-minded development—all in a single, cohesive, runnable project with documented, measured performance results.
