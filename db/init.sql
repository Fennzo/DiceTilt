-- =============================================================
-- DiceTilt PostgreSQL Schema
-- Mounted at: /docker-entrypoint-initdb.d/init.sql
-- Executes once on first container boot.
-- =============================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- =============================================================
-- TABLE: users
-- =============================================================
CREATE TABLE IF NOT EXISTS users (
    id                   UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
    active_server_seed   VARCHAR(64)  NOT NULL,
    previous_server_seed VARCHAR(64),
    created_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- =============================================================
-- TABLE: wallets
-- =============================================================
CREATE TABLE IF NOT EXISTS wallets (
    id             UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id        UUID          NOT NULL
                       REFERENCES users(id) ON DELETE CASCADE,
    chain          VARCHAR(20)   NOT NULL,
    currency       VARCHAR(10)   NOT NULL,
    balance        NUMERIC(30,8) NOT NULL DEFAULT 0,
    current_nonce  INTEGER       NOT NULL DEFAULT 0,
    wallet_address VARCHAR(100)  NOT NULL,
    created_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

    CONSTRAINT chk_wallets_nonce_non_negative
        CHECK (current_nonce >= 0),
    CONSTRAINT chk_wallets_chain_valid
        CHECK (chain IN ('ethereum', 'solana')),
    CONSTRAINT chk_wallets_currency_valid
        CHECK (currency IN ('ETH', 'SOL', 'USDC', 'USDT')),
    CONSTRAINT chk_wallets_balance_non_negative
        CHECK (balance >= 0),
    CONSTRAINT uq_user_chain_currency
        UNIQUE (user_id, chain, currency)
);

-- =============================================================
-- TABLE: deposits (idempotency for DepositReceived Kafka events)
-- =============================================================
CREATE TABLE IF NOT EXISTS deposits (
    deposit_id     UUID          PRIMARY KEY,
    user_id        UUID          NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    chain          VARCHAR(20)   NOT NULL,
    currency       VARCHAR(10)   NOT NULL,
    amount         NUMERIC(30,8) NOT NULL,
    wallet_address VARCHAR(100)  NOT NULL,
    tx_hash        VARCHAR(100)  NOT NULL,
    block_number   BIGINT        NOT NULL,
    deposited_at   TIMESTAMPTZ   NOT NULL,
    CONSTRAINT chk_deposits_chain_valid CHECK (chain IN ('ethereum', 'solana')),
    CONSTRAINT chk_deposits_currency_valid CHECK (currency IN ('ETH', 'SOL', 'USDC', 'USDT')),
    CONSTRAINT uq_deposits_tx_hash UNIQUE (tx_hash)
);

CREATE INDEX IF NOT EXISTS idx_deposits_user_id ON deposits (user_id);

-- =============================================================
-- TABLE: withdrawals (idempotency for WithdrawalCompleted Kafka events)
-- =============================================================
CREATE TABLE IF NOT EXISTS withdrawals (
    withdrawal_id  UUID          PRIMARY KEY,
    user_id        UUID          NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    chain          VARCHAR(20)   NOT NULL,
    currency       VARCHAR(10)   NOT NULL,
    amount         NUMERIC(30,8) NOT NULL,
    to_address     VARCHAR(100)  NOT NULL,
    tx_hash        VARCHAR(100)  NOT NULL,
    completed_at   TIMESTAMPTZ   NOT NULL,
    CONSTRAINT chk_withdrawals_chain_valid CHECK (chain IN ('ethereum', 'solana')),
    CONSTRAINT chk_withdrawals_currency_valid CHECK (currency IN ('ETH', 'SOL', 'USDC', 'USDT'))
);

CREATE INDEX IF NOT EXISTS idx_withdrawals_user_id ON withdrawals (user_id);

-- =============================================================
-- TABLE: transactions
-- =============================================================
CREATE TABLE IF NOT EXISTS transactions (
    bet_id        UUID          PRIMARY KEY,
    user_id       UUID          NOT NULL
                      REFERENCES users(id) ON DELETE RESTRICT,
    chain         VARCHAR(20)   NOT NULL,
    currency      VARCHAR(10)   NOT NULL,
    wager_amount  NUMERIC(30,8) NOT NULL,
    payout_amount NUMERIC(30,8) NOT NULL DEFAULT 0,
    game_result   INTEGER       NOT NULL,
    client_seed   VARCHAR(64)   NOT NULL,
    nonce_used    INTEGER       NOT NULL,
    outcome_hash  VARCHAR(128)  NOT NULL,
    executed_at   TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

    CONSTRAINT chk_tx_chain_valid
        CHECK (chain IN ('ethereum', 'solana')),
    CONSTRAINT chk_tx_currency_valid
        CHECK (currency IN ('ETH', 'SOL', 'USDC', 'USDT')),
    CONSTRAINT chk_tx_wager_positive
        CHECK (wager_amount > 0),
    CONSTRAINT chk_tx_payout_non_negative
        CHECK (payout_amount >= 0),
    CONSTRAINT chk_tx_result_in_range
        CHECK (game_result BETWEEN 1 AND 100),
    CONSTRAINT chk_tx_nonce_non_negative
        CHECK (nonce_used >= 0)
);

-- =============================================================
-- INDEXES
-- =============================================================
CREATE INDEX IF NOT EXISTS idx_wallets_user_id
    ON wallets (user_id);

-- Prevent multiple users from sharing the same real wallet address on the same chain.
-- Uses a partial unique index to exclude the Solana placeholder (all users share it until
-- real Solana addresses are implemented).
CREATE UNIQUE INDEX IF NOT EXISTS idx_wallets_unique_address_chain
    ON wallets (LOWER(wallet_address), chain)
    WHERE wallet_address != 'placeholder-solana-address';

CREATE INDEX IF NOT EXISTS idx_transactions_user_id
    ON transactions (user_id);

CREATE INDEX IF NOT EXISTS idx_transactions_executed_at
    ON transactions (executed_at DESC);

CREATE INDEX IF NOT EXISTS idx_transactions_user_executed
    ON transactions (user_id, executed_at DESC);

CREATE INDEX IF NOT EXISTS idx_users_active_seed
    ON users (active_server_seed);

-- =============================================================
-- TRIGGER: auto-maintain updated_at
-- =============================================================
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_users_updated_at
    BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER trg_wallets_updated_at
    BEFORE UPDATE ON wallets
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
