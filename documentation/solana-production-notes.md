# DiceTilt — Solana Production Architecture Notes

**Audience:** Senior engineers, blockchain architects, technical reviewers.

This document explains the deliberate architectural decisions behind the Solana layer in DiceTilt and details what a production-grade implementation would require beyond the PoC stub. The Solana on-chain pipeline (Solana Listener + Solana Payout Worker + Anchor Treasury) is architecturally designed and documented but intentionally not implemented as running services in this PoC. This document explains why, and what a production implementation at a real-money casino platform must handle that a basic tutorial implementation would not.

For the stub service layout, see `architecture-overview.md`. For the planned flow diagrams, see `blockchain-flows.md`.

---

## 1. Why the Solana Layer Is Stubbed

The EVM layer is fully implemented because it demonstrates the complete event-driven financial pipeline end-to-end: on-chain deposit detection, Kafka routing, idempotent ledger settlement, real-time balance push, and isolated payout signing. Implementing the same pipeline a second time on Solana in a PoC adds no new architectural signal — the patterns are identical at the service layer.

What the Solana layer adds is **chain-specific complexity that a PoC cannot implement faithfully**. A partial Solana implementation that skips the hard parts would be worse than no implementation — it would imply the easy path is the real path. The sections below document those hard parts explicitly.

---

## 2. USDC, Not SOL — The Currency Decision

The first production decision that differs from a tutorial implementation: **a real casino platform would not use native SOL as its gaming currency**.

Native SOL is a volatile asset. A player who deposits 10 SOL today has a gaming balance that fluctuates in USD value between bets. Casino economics require stable unit values — the house edge is calculated against a stable denomination.

**Production choice: USDC (an SPL token)**

USDC on Solana is an SPL token. This changes the entire implementation surface:

| Concern | Native SOL | USDC (SPL Token) |
|---------|-----------|-----------------|
| Transfer mechanism | System Program `transfer` instruction | SPL Token Program `transfer` instruction |
| Destination requirement | Just a valid public key | Destination must have an **Associated Token Account (ATA)** for USDC |
| Treasury holds | SOL balance | USDC token account balance |
| Payout worker signs | `SystemProgram.transfer` | `createTransferInstruction` via `@solana/spl-token` |
| Deposit detection | `SystemProgram` account balance delta | SPL Token Program `Transfer` log on USDC mint |

The DiceTilt architecture stub uses SOL for demo simplicity. A production MonkeyTilt-style implementation uses USDC, which surfaces the ATA problem described in the next section.

---

## 3. The ATA Problem — Payout Worker Edge Case

The most operationally significant Solana-specific issue for a payout worker is the **Associated Token Account (ATA) existence check**.

Every Solana wallet that wants to hold USDC must have an ATA — a program-derived account owned by the SPL Token Program, seeded from the wallet address and the USDC mint. If the destination ATA does not exist, the transfer instruction **fails**. Unlike EVM where you can send ETH to any address, Solana requires the recipient to have a funded token account.

### The race conditions this creates for a casino payout worker:

**Case 1 — New user, first withdrawal.** The user deposited USDC via a wallet that already had a USDC ATA. Their withdrawal target is the same wallet — ATA exists, transfer succeeds. This is the happy path.

**Case 2 — User's wallet never held USDC.** Unlikely in practice but possible. ATA does not exist. The payout transaction fails. The Kafka message goes to DLQ. The user's on-chain balance was already deducted from Redis (pre-deducted atomically before the `WithdrawalRequested` event was produced). Recovery requires a credit-back event, re-queue, and ATA creation — a multi-step remediation path.

**Case 3 — New wallet created specifically for the withdrawal.** Fresh wallet, no ATA. Same as Case 2.

### Production handling:

The payout worker must inspect the destination ATA before signing the transfer:

```
1. Derive ATA address: getAssociatedTokenAddress(walletAddress, USDC_MINT)
2. getAccountInfo(ata_address) — check existence
3a. If exists → proceed with transfer instruction
3b. If not exists → prepend createAssociatedTokenAccountInstruction to the transaction
    (this costs ~0.002 SOL in rent from the Treasury keypair — budget must be maintained)
```

Step 3b means the Treasury must hold a small SOL float (not just USDC) to fund ATA creation for new users. This is an operational cost the EVM Treasury.sol never has to consider.

---

## 4. Commitment Levels — The Casino-Specific Tradeoff

Solana exposes three confirmation states for a transaction:

| Level | Meaning | Approximate time |
|-------|---------|-----------------|
| `processed` | Included in a block by one validator | ~400ms |
| `confirmed` | Supermajority of validators have voted for the block | ~800ms |
| `finalized` | Block is locked and cannot be reverted | ~13–15s |

This choice matters differently for **deposits** vs **payouts**, and a casino context changes the calculus relative to a generic dApp.

### Deposits — use `finalized`

Crediting a player's gaming balance before a deposit is finalized creates reversal risk. If the block containing the deposit is forked (rare but possible on Solana under validator instability), the on-chain deposit disappears but the platform has already credited and potentially paid out against that balance.

**Production decision: listen for `finalized` commitment before publishing `DepositReceived` to Kafka.**

This adds ~13–15s latency to deposit confirmation but eliminates reversal risk entirely. The UX impact is mitigated because:
1. Players see a "deposit pending" state — standard in any financial product
2. The gaming balance (10 SOL/USDC default) means players can start immediately without waiting for deposits
3. The real-time update via Redis Pub/Sub → WebSocket means the balance updates the moment finalization is confirmed

The DiceTilt EVM Listener uses ethers.js with default confirmation depth. The Solana Listener stub would be configured for `finalized` commitment at the connection level:

```typescript
const connection = new Connection(RPC_URL, 'finalized');
```

### Payouts — use `confirmed`

The reverse applies for withdrawals. The Treasury is signing the outgoing transaction. Once it's confirmed (supermajority vote), reversal is extremely unlikely even if not technically finalized. Waiting for finalization adds ~13s of user-perceived delay on the withdrawal side for no material safety gain — the platform is the one signing, so there is no adversarial counterparty risk.

**Production decision: treat `confirmed` as sufficient for payout success. Publish `WithdrawalCompleted` to Kafka on `confirmed`.**

This asymmetry — `finalized` for incoming, `confirmed` for outgoing — is a deliberate product decision that balances safety against UX, not a technical oversight.

---

## 5. Transaction Model — No Sequential Nonces

The EVM payout worker uses a `payoutBusy` mutex specifically to prevent nonce collisions. Ethereum transactions require a sequential nonce per sender address. Two concurrent transactions with the same nonce will conflict — one will fail.

Solana does not use sequential nonces. Instead, every transaction includes a **recent blockhash** — a hash of a recent block that the transaction must reference. This blockhash expires after approximately 150 slots (~60–90 seconds, depending on slot timing; slots target 400ms but may fluctuate 400–600ms). If a transaction is not included within that window it is invalid and must be rebuilt with a fresh blockhash. See [Transaction Confirmation & Expiration](https://solana.com/developers/guides/advanced/confirmation) for details.

This eliminates the nonce collision problem but introduces a different failure mode:

**Solana payout worker failure modes the EVM worker does not have:**

| Failure | Cause | Recovery |
|---------|-------|---------|
| `BlockhashNotFound` | Payout worker built the transaction, queued for retry, blockhash expired before retry | Rebuild transaction with `getLatestBlockhash()`, re-sign, resubmit |
| `AlreadyProcessed` | Retry submitted a duplicate (same blockhash + same instructions) | Idempotent — safe to ignore, treat as success |
| RPC rate limit during high load | Public RPC endpoints throttle `sendTransaction` | Use dedicated RPC (Helius, Triton) — critical for production |

The `payoutBusy` mutex pattern from the EVM worker maps to Solana as a **transaction confirmation poller** — after submitting, the worker must poll `getSignatureStatus` until `confirmed` or timeout, before processing the next withdrawal. Without this, concurrent submissions with the same recent blockhash create `AlreadyProcessed` ambiguity.

---

## 6. RPC Infrastructure — Not Optional

The EVM layer uses a local Anvil node — zero latency, no rate limits, deterministic. The Solana PoC stub uses `solana-test-validator` locally for the same reasons.

In production, the difference is significant:

**Solana public RPC (`api.mainnet-beta.solana.com`) is unsuitable for a financial application:**
- Rate-limited aggressively (~100 requests/second per IP)
- No guaranteed `sendTransaction` delivery under load
- No websocket subscription SLA

**Production requirement: dedicated RPC from Helius or Triton**

These providers offer:
- Higher rate limits (10,000+ req/s tiers)
- `sendTransaction` with `skipPreflight: false` and automatic retry logic
- Reliable websocket subscriptions for the Solana Listener's `onLogs` / `onAccountChange` events
- Staked validator connections for faster transaction landing (Jito-adjacent)

This is an operational cost with no EVM equivalent — `evm-node` (Anvil) in Docker is free. Production Solana RPC is a paid infrastructure dependency.

---

## 7. Connection to the Trade Router — Where Jito and Jupiter Fit

The sections above cover the **deposit/withdrawal pipeline** — the direct mapping of the EVM layer to Solana. This is a solved problem space: Anchor programs, SPL tokens, ATAs, commitment levels.

The architecturally more interesting layer is the **Trade Router** (Rust stub in this PoC). This is where the MonkeyTilt × Warlock Labs acquisition context applies.

MonkeyTilt's Tilt Trade feature allows players to swap between assets inside the platform. This is not a simple SPL transfer — it requires:

**Jupiter** (liquidity aggregation): computes the optimal swap route across all Solana DEXes (Raydium, Orca, Meteora, Phoenix) to minimise price impact on the user's swap. Jupiter is a public protocol; the integration complexity is in knowing how to use its routing API under latency constraints.

**Jito** (MEV protection): submits the swap as a transaction bundle directly to Jito's block engine, bypassing the public mempool. This prevents sandwich attacks — front-running bots cannot see the transaction before it lands in a block. The user pays a small Jito tip (typically 0.001–0.01 SOL) instead of losing value to extractors.

**Why Rust for the Trade Router:**

Rust's `tokio` multi-threaded async runtime allows the route computation, RPC calls, and bundle construction to run in parallel across multiple candidate routes simultaneously. While Node.js excels at I/O-bound operations, its single-threaded event loop limits CPU-bound route computation parallelism, and worker threads add overhead. The ~50–200ms window for profitable MEV arbitrage requires the fine-grained parallelism and lower latency overhead that Rust provides.

**Warlock Labs built the proprietary layer on top of Jupiter and Jito** — the routing heuristics, tip optimisation strategy, validator targeting, and execution infrastructure. Jupiter and Jito are open protocols; the Warlock expertise was in knowing how to use them at production scale for a financial gaming platform specifically.

The DiceTilt Trade Router stub represents this service boundary. Its Kafka topic (`TradeExecuted`) is defined in `kafka-event-topology.md`. The Rust selection is documented in `architecture-overview.md`.

---

## 8. Summary — What a Production Solana Layer Requires

| Concern | PoC Stub | Production Requirement |
|---------|----------|----------------------|
| Currency | Native SOL (demo) | USDC (SPL token, stable value) |
| Deposit confirmation | `confirmed` (fast) | `finalized` (~13s, eliminates reversal risk) |
| Payout confirmation | — | `confirmed` sufficient, poll `getSignatureStatus` |
| ATA handling | Not implemented | Check existence before every payout; fund creation from Treasury SOL float |
| RPC provider | `solana-test-validator` (local) | Helius or Triton dedicated node |
| Transaction expiry | Not implemented | Rebuild on `BlockhashNotFound`; handle `AlreadyProcessed` as idempotent success |
| Nonce model | N/A (no sequential nonces) | Recent blockhash + confirmation poller replaces `payoutBusy` mutex |
| Swap routing | Not implemented | Jupiter + Jito via Trade Router (Rust) |

The Solana deposit/withdrawal pipeline is architecturally identical to the EVM pipeline at the service boundary level — both emit `DepositReceived` and `WithdrawalCompleted` to the same Kafka topics, consumed by the same Ledger Consumer. The Kafka-based chain isolation means a Solana implementation failure cannot affect the EVM pipeline. What differs is entirely within the Solana Listener and Payout Worker containers — the chain-specific details documented above.
