# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

**DiceTilt** is a fully sovereign, locally-deployable hybrid Web2/Web3 Crypto Casino PoC. All documentation lives in `/documentation/`. The master build prompt is in `MASTER_PROMPT.md`.

## Build System

- **Monorepo:** pnpm workspaces (`pnpm-workspace.yaml`)
- **Language:** TypeScript (strict mode), exception: Trade Router and Solana Treasury use Rust
- **Packages:** `packages/shared-types` — Zod schemas, Kafka event interfaces, WebSocket types
- **Services:** `services/*` — each microservice has its own `package.json`, `tsconfig.json`, Dockerfile

## Commands

```bash
pnpm install          # Install all workspace dependencies
pnpm build            # Build all packages and services
pnpm test             # Run all tests across workspace
pnpm lint             # ESLint across all TypeScript
pnpm format           # Prettier format all files
```

## Architecture Notes

- The Provably Fair Worker is **stateless** — the API Gateway passes all inputs (including server seed)
- Nonces live in **Redis** (`user:{id}:nonce:{chain}:{currency}`), checkpointed in `wallets.current_nonce`
- All Nginx traffic routes through the API Gateway — PF Worker is internal only
- PoC uses deterministic Hardhat keys from `.env` — no Ansible Vault required at runtime
- Users start with default balance (10 ETH, 10 SOL) — no on-chain deposit needed for demo
- **Phase 5 (Sovereign Web3):** EVM node (Anvil), evm-deploy (Treasury.sol), evm-listener, evm-payout-worker, ledger-consumer. Solana layer stubbed for future.
- **Demo mode:** Open `/?demo=1` to use Hardhat account #1 (pre-funded on Anvil) for Deposit testing
