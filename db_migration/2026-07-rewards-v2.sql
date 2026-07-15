-- ============================================================================
-- Rewards v2: creator claims + claim history (2026-07)
-- Idempotent — safe to run on the live database.
--
-- 1. reward_claims gains a creator-side ledger: claimed_creator_amount tracks the
--    cumulative creator fees already claimed, pending_creator_amount records the
--    creator portion of an in-flight claim (pending_amount stays the TOTAL, since
--    that is what the on-chain transfer is verified against).
-- 2. reward_claim_history records every finalized claim for the profile page.
-- ============================================================================

ALTER TABLE reward_claims ADD COLUMN IF NOT EXISTS claimed_creator_amount TEXT NOT NULL DEFAULT '0';
ALTER TABLE reward_claims ADD COLUMN IF NOT EXISTS pending_creator_amount TEXT;

CREATE TABLE IF NOT EXISTS reward_claim_history (
    id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    chain          TEXT NOT NULL,
    wallet         TEXT NOT NULL,
    trader_amount  TEXT NOT NULL DEFAULT '0',   -- lamports / wei
    creator_amount TEXT NOT NULL DEFAULT '0',   -- lamports / wei
    total_amount   TEXT NOT NULL,               -- lamports / wei (trader + creator)
    tx_signature   TEXT NOT NULL,               -- Solana signature / EVM tx hash
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- One history row per on-chain payout; makes recording idempotent under retries.
    CONSTRAINT reward_claim_history_tx_unique UNIQUE (chain, tx_signature)
);

CREATE INDEX IF NOT EXISTS reward_claim_history_wallet_idx
    ON reward_claim_history (chain, wallet, created_at DESC);
