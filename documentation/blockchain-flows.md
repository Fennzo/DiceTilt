# DiceTilt — Blockchain Flows

**Audience:** Software architects, blockchain engineers.

All deposit and withdrawal flows for both EVM (Hardhat/Anvil) and Solana (solana-test-validator) chains. Both chains are fully local — no internet, no real assets, no faucet requests. For the auth and game loop flows, see `sequence-diagrams.md`.

---

## Flow Index

| # | Flow | Chain |
|---|---|---|
| 1 | EVM Deposit — Smart Contract to Balance Update | EVM |
| 2 | Solana Deposit — Anchor Program to Balance Update | Solana |
| 3 | Simultaneous Multi-Chain Deposits (Independence Proof) | Both |
| 4 | EVM Withdrawal — API to Signed On-Chain Transaction | EVM |
| 5 | Solana Withdrawal — API to Signed On-Chain Transaction | Solana |
| 6 | Withdrawal — Insufficient Balance Rejection | Both |
| 7 | Chain-Aware Withdrawal Routing Diagram | Both |
| 8 | EVM Listener — Reconnection with Exponential Backoff | EVM |
| 9 | Solana Listener — Reconnection with Exponential Backoff | Solana |

---

## Flow 1 — EVM Deposit (Smart Contract → Balance Update)

This flow documents the full architectural deposit pipeline. In the PoC demo, users start with default balances (10 ETH, 10 SOL) — the deposit flow is not part of the primary recruiter experience but remains fully implemented in the backend. The EVM Listener detects `Deposit` events and feeds them into the shared Kafka pipeline.

```mermaid
sequenceDiagram
    participant B as Browser (Burner Wallet)
    participant Anvil as Hardhat / Anvil :8545
    participant TSol as Treasury.sol
    participant EL as EVM Listener Service
    participant Kafka as Kafka
    participant LC as Ledger Consumer
    participant PG as PostgreSQL
    participant Redis as Redis
    participant API as API Gateway

    Note over B: deploy script pre-funded burnerWallet with test ETH

    B->>Anvil: eth_sendTransaction → Treasury.deposit(amount) signed by burnerWallet
    Anvil->>TSol: execute deposit() — transfer ETH to contract
    TSol->>TSol: emit Deposit(playerAddress, amount, timestamp)
    Anvil-->>B: tx receipt { status: 1, txHash: "0xabc..." }

    Note over EL: Continuously listening via ethers.js contract.on('Deposit', ...)
    EL->>EL: receive Deposit event { player: "0x...", amount: "1000000000000000000", block: 42 }
    EL->>EL: derive userId from wallet_address lookup
    EL->>Kafka: produce DepositReceived { chain: "ethereum", currency: "ETH", userId, amount: "1.0", txHash, blockNumber }
    Note over EL: acks: 'all' — waits for all Kafka replicas to acknowledge

    LC->>Kafka: consume DepositReceived (chain: "ethereum")
    LC->>PG: INSERT INTO wallets (user_id, chain='ethereum', currency='ETH') ON CONFLICT (user_id,chain,currency) DO UPDATE SET balance = balance + 1.0
    PG-->>LC: updated balance: "101.00000000"
    LC->>Redis: SET user:{userId}:balance:ethereum:ETH "101.00000000"
    LC->>Redis: PUBLISH user:updates:{userId} { type: "balance_update", chain: "ethereum", currency: "ETH", balance: 101.0 }
    LC->>Kafka: commit offset

    Note over API: API Gateway SUBSCRIBEd to user:updates:{userId} — receives Pub/Sub message
    API->>B: WS push → { type: "BALANCE_UPDATE", balance: 101.0, chain: "ethereum", currency: "ETH" }
    Note over B: Balance updates in real-time without page refresh
```

---

## Flow 2 — Solana Deposit (Anchor Program → Balance Update)

Mirrors Flow 1 using Solana-specific technology. The Anchor program emits `DepositEvent` which the Solana Listener decodes via the IDL and feeds into the same Kafka topic as the EVM Listener.

```mermaid
sequenceDiagram
    participant B as Browser (Solana Keypair)
    participant SolVal as solana-test-validator :8899
    participant AT as Anchor Treasury Program
    participant SL as Solana Listener Service
    participant Kafka as Kafka
    participant LC as Ledger Consumer
    participant PG as PostgreSQL
    participant Redis as Redis
    participant API as API Gateway

    Note over B: Burner keypair pre-funded via solana-test-validator --mint flag

    B->>SolVal: sendTransaction → deposit(amount: u64) instruction, signed by burnerKeypair
    SolVal->>AT: execute deposit() — transfer SPL tokens to Treasury ATA
    AT->>AT: emit DepositEvent { player: PublicKey, amount: u64, timestamp: i64 }
    SolVal-->>B: TransactionSignature "3Bw..."

    Note over SL: Program.addEventListener('DepositEvent', ...) via @coral-xyz/anchor
    SL->>SL: receive DepositEvent { player: "HxK...", amount: 1_000_000, timestamp: 1700000000 }
    SL->>SL: amount = 1_000_000 / 10^6 → "1.000000" SOL (normalised to NUMERIC(30,8))
    SL->>SL: derive userId from wallets WHERE wallet_address = player.toBase58()
    SL->>Kafka: produce DepositReceived { chain: "solana", currency: "SOL", userId, amount: "1.000000", txSignature: "3Bw..." }

    LC->>Kafka: consume DepositReceived (chain: "solana")
    LC->>PG: INSERT INTO wallets ON CONFLICT (user_id, 'solana', 'SOL') DO UPDATE SET balance = balance + 1.0
    PG-->>LC: updated balance: "11.00000000"
    LC->>Redis: SET user:{userId}:balance:solana:SOL "11.00000000"
    LC->>Redis: PUBLISH user:updates:{userId} { type: "balance_update", chain: "solana", currency: "SOL", balance: 11.0 }
    LC->>Kafka: commit offset

    Note over API: API Gateway receives Pub/Sub message
    API->>B: WS push → { type: "BALANCE_UPDATE", balance: 11.0, chain: "solana", currency: "SOL" }
```

---

## Flow 3 — Simultaneous Multi-Chain Deposits (Independence Proof)

Demonstrates that the EVM and Solana deposit pipelines are completely independent. A failure in one chain's listener does not block the other.

```mermaid
sequenceDiagram
    participant B as Browser
    participant Anvil as Hardhat/Anvil
    participant SolVal as Solana Validator
    participant EL as EVM Listener
    participant SL as Solana Listener
    participant Kafka as Kafka (DepositReceived topic)
    participant LC as Ledger Consumer

    par EVM deposit
        B->>Anvil: Treasury.deposit(0.5 ETH)
        Anvil-->>EL: Deposit event emitted
        EL->>Kafka: produce { chain: "ethereum", amount: "0.5", currency: "ETH" }
    and Solana deposit (concurrent)
        B->>SolVal: deposit(0.5 SOL) instruction
        SolVal-->>SL: DepositEvent emitted
        SL->>Kafka: produce { chain: "solana", amount: "0.5", currency: "SOL" }
    end

    Note over Kafka: Both messages land on the same DepositReceived topic
    Note over LC: Ledger Consumer processes batches in parallel (eachBatch + Promise.all by user_id); 3 replicas = 3 partition processors

    LC->>Kafka: consume DepositReceived (ethereum, 0.5 ETH)
    LC->>LC: UPDATE wallets SET balance + 0.5 WHERE chain='ethereum'
    LC->>Kafka: consume DepositReceived (solana, 0.5 SOL)
    LC->>LC: UPDATE wallets SET balance + 0.5 WHERE chain='solana'

    Note over EL,SL: If Solana validator goes down, EVM deposits continue uninterrupted (Constraint 19)
    Note over EL,SL: If EVM node goes down, Solana deposits continue uninterrupted
    Note over EL,SL: Each listener has its own reconnection loop with exponential backoff
```

---

## Flow 4 — EVM Withdrawal (API → Signed On-Chain Transaction)

The API Gateway never holds a private key. It only emits a Kafka event. The isolated EVM Payout Worker — the only service with access to the treasury private key — signs and submits the transaction.

```mermaid
sequenceDiagram
    participant B as Browser
    participant N as Nginx
    participant API as API Gateway
    participant Redis as Redis
    participant Kafka as Kafka
    participant EPW as EVM Payout Worker
    participant Anvil as Hardhat / Anvil
    participant TSol as Treasury.sol

    B->>N: POST /api/v1/withdraw { amount: 0.5, chain: "ethereum", currency: "ETH" }  Bearer JWT
    N->>API: forward

    API->>API: jwt.verify + Redis session check
    API->>Redis: EVAL lua_balance_check_deduct(userId, "ethereum", "ETH", 0.5)
    Note over Redis: Atomic: check balance >= 0.5, deduct if sufficient
    Redis-->>API: { success: true, newBalance: 99.5 }

    API->>Kafka: produce WithdrawalRequested { withdrawalId: uuid, userId, amount: 0.5, chain: "ethereum", currency: "ETH", toAddress: "0x..." }
    Note over API: acks: 'all' — durable delivery guaranteed before HTTP response
    API-->>B: HTTP 202 { withdrawalId: "uuid", status: "PENDING" }

    Note over EPW: Consuming WithdrawalRequested — filters on chain === "ethereum"
    EPW->>Kafka: consume WithdrawalRequested (chain: "ethereum")
    EPW->>EPW: read TREASURY_OWNER_PRIVATE_KEY from env (PoC: deterministic Hardhat key from .env; production: Ansible Vault)
    EPW->>EPW: ethers.Wallet(privateKey, provider) → treasuryWallet
    EPW->>Anvil: treasuryContract.payout(toAddress, amount) — signed tx
    Anvil->>TSol: execute payout() — transfer ETH from contract to recipient
    TSol-->>Anvil: emit Payout(recipient, amount)
    Anvil-->>EPW: tx receipt { status: 1, txHash: "0xdef..." }

    EPW->>Kafka: produce WithdrawalCompleted { withdrawalId, userId, chain, amount, txHash, completedAt }
    EPW->>Kafka: commit offset

    Note over LC: Ledger Consumer consumes WithdrawalCompleted
    LC->>LC: record withdrawal (optional DB insert for audit)
    LC->>Redis: PUBLISH user:updates:{userId} { type: "withdrawal_completed", withdrawalId, txHash, chain, currency }
    Note over API: API Gateway receives Pub/Sub → pushes WITHDRAWAL_COMPLETED to WebSocket
    API->>B: WS push → { type: "WITHDRAWAL_COMPLETED", withdrawalId, txHash, chain, currency }
    Note over B: UI no longer shows "PENDING"

    Note over EPW: dicetilt_withdrawal_completions_total{chain="ethereum"} incremented
```

---

## Flow 5 — Solana Withdrawal (API → Signed On-Chain Transaction)

```mermaid
sequenceDiagram
    participant B as Browser
    participant API as API Gateway
    participant Redis as Redis
    participant Kafka as Kafka
    participant SPW as Solana Payout Worker
    participant SolVal as Solana Validator
    participant AT as Anchor Treasury Program

    B->>API: POST /api/v1/withdraw { amount: 1.0, chain: "solana", currency: "SOL" }  Bearer JWT
    API->>Redis: EVAL lua_balance_check_deduct(userId, "solana", "SOL", 1.0)
    Redis-->>API: { success: true, newBalance: 10.0 }

    API->>Kafka: produce WithdrawalRequested { ..., chain: "solana", currency: "SOL", toAddress: "HxK..." }
    API-->>B: HTTP 202 { withdrawalId, status: "PENDING" }

    Note over SPW: Consuming WithdrawalRequested — filters on chain === "solana"
    SPW->>Kafka: consume WithdrawalRequested (chain: "solana")
    SPW->>SPW: read SOLANA_TREASURY_KEYPAIR from env (PoC: pre-generated key from .env; production: Ansible Vault)
    SPW->>SPW: Keypair.fromSecretKey(secretKey) → treasuryKeypair
    SPW->>SPW: build withdraw(amount, recipient) Anchor instruction
    SPW->>SolVal: sendTransaction(signedWithdrawTx)
    SolVal->>AT: execute withdraw() — transfer SPL tokens to recipient ATA
    AT-->>SolVal: emit WithdrawEvent { recipient, amount, timestamp }
    SolVal-->>SPW: TransactionSignature "5Qr..."

    SPW->>Kafka: produce WithdrawalCompleted { withdrawalId, userId, chain, amount, txSignature, completedAt }
    SPW->>Kafka: commit offset

    Note over LC: Ledger Consumer consumes WithdrawalCompleted
    LC->>Redis: PUBLISH user:updates:{userId} { type: "withdrawal_completed", ... }
    Note over API: API Gateway pushes WITHDRAWAL_COMPLETED to WebSocket
    Note over SPW: dicetilt_withdrawal_completions_total{chain="solana"} incremented
```

---

## Flow 6 — Withdrawal, Insufficient Balance Rejection

```mermaid
sequenceDiagram
    participant B as Browser
    participant API as API Gateway
    participant Redis as Redis
    participant Kafka as Kafka

    B->>API: POST /api/v1/withdraw { amount: 999, chain: "ethereum", currency: "ETH" }

    API->>Redis: EVAL lua_balance_check_deduct(userId, "ethereum", "ETH", 999)
    Note over Redis: Lua: IF balance (50) < amount (999) THEN return error
    Redis-->>API: { success: false, reason: "INSUFFICIENT_BALANCE" }

    Note over API: Kafka is never touched. No WithdrawalRequested event produced.
    Note over API: dicetilt_double_spend_rejections_total incremented
    API-->>B: HTTP 400 { code: "INSUFFICIENT_BALANCE", message: "Insufficient balance for withdrawal" }
```

---

## Flow 7 — Chain-Aware Withdrawal Routing Diagram

Both payout workers subscribe to the same `WithdrawalRequested` Kafka topic but each only processes messages matching their chain. No hardcoded routing logic exists in the API Gateway.

```mermaid
flowchart TD
    API["API Gateway"]
    WRTopic["Kafka: WithdrawalRequested\n(single shared topic)"]

    API -->|"produce\n{ chain, currency, amount, toAddress }"| WRTopic

    WRTopic --> EVMFilter{"chain === 'ethereum'?"}
    WRTopic --> SolFilter{"chain === 'solana'?"}

    EVMFilter -->|"Yes — consume"| EVMPay["EVM Payout Worker\nethers.Wallet signing"]
    EVMFilter -->|"No — skip"| EVMSkip["(message ignored)"]

    SolFilter -->|"Yes — consume"| SolPay["Solana Payout Worker\nAnchor instruction signing"]
    SolFilter -->|"No — skip"| SolSkip["(message ignored)"]

    EVMPay --> Anvil["Hardhat/Anvil\nTreasury.payout()"]
    SolPay --> SolVal["Solana Validator\nAnchor withdraw()"]
```

> **Design principle (Constraint 20):** The `chain` and `currency` fields are carried in the Kafka event payload — not derived from any gateway logic. Each payout worker is responsible for its own filtering. This enables adding new chains (e.g., Tron, Bitcoin Lightning) by deploying a new payout worker without modifying any existing service.

---

## Flow 8 — EVM Listener: Reconnection with Exponential Backoff

The EVM Listener operates as a long-running process. WebSocket connections to Hardhat/Anvil can drop. The listener must reconnect autonomously without human intervention (Constraint 19).

```mermaid
sequenceDiagram
    participant EL as EVM Listener Service
    participant Anvil as Hardhat / Anvil :8545
    participant Health as Health Check Endpoint
    participant Prom as Prometheus

    Note over EL: Normal operation — listening for Deposit events
    EL->>Anvil: WebSocket subscribed to contract events

    Anvil--xEL: WebSocket connection dropped (node restart / network issue)
    EL->>EL: onDisconnect handler triggered
    EL->>Health: health check returns { status: "degraded", chain: "ethereum" }
    EL->>Prom: increment dicetilt_web3_listener_reconnections_total{chain="ethereum"}

    loop Exponential Backoff (attempt 1..N)
        EL->>EL: wait = min(baseDelay * 2^attempt, maxDelay)  e.g., 1s, 2s, 4s, 8s, 30s cap
        EL->>Anvil: attempt reconnect
        alt Reconnect successful
            Anvil-->>EL: WebSocket connected
            EL->>EL: re-subscribe to Deposit events from last processed block
            EL->>Health: health check returns { status: "healthy" }
            Note over EL: No events missed — re-subscribe from last known block number
        else Still failing
            EL->>EL: log error, continue backoff loop
        end
    end
```

---

## Flow 9 — Solana Listener: Reconnection with Exponential Backoff

Identical pattern to Flow 8 but using the Solana JSON-RPC WebSocket connection.

```mermaid
sequenceDiagram
    participant SL as Solana Listener Service
    participant SolVal as Solana Validator :8900
    participant Health as Health Check Endpoint
    participant Prom as Prometheus

    Note over SL: Normal operation — Program.addEventListener active
    SL->>SolVal: WebSocket subscribed to Anchor program logs

    SolVal--xSL: WebSocket connection dropped
    SL->>SL: onDisconnect / error handler triggered
    SL->>Health: { status: "degraded", chain: "solana" }
    SL->>Prom: increment dicetilt_web3_listener_reconnections_total{chain="solana"}

    loop Exponential Backoff
        SL->>SL: wait exponential delay
        SL->>SolVal: attempt WebSocket reconnect to :8900
        alt Reconnect successful
            SolVal-->>SL: connected
            SL->>SL: re-register Program.addEventListener from last confirmed slot
            SL->>Health: { status: "healthy" }
        else Failing
            SL->>SL: log, continue backoff
        end
    end

    Note over SL: Solana reconnection is fully independent of EVM Listener state (Constraint 19)
    Note over SL: EVM deposits continue normally while Solana reconnects
```
