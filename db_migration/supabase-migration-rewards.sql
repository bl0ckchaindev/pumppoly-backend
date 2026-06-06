-- Migration: trader rewards pool — reward_fee column + wash-trade cooldown config
-- Run this in the Supabase SQL Editor.

-- 1. Add reward_fee column to trader_fees
--    Stores the 0.30% reward portion of each trade separately from platform_fee/creator_fee.
ALTER TABLE trader_fees
    ADD COLUMN IF NOT EXISTS reward_fee TEXT NOT NULL DEFAULT '0';

-- 2. Composite index for the per-(wallet, mint) eligibility window query
--    Speeds up the LAG() window function used to detect rapid same-token trading.
CREATE INDEX IF NOT EXISTS idx_trader_fees_wallet_mint_created
    ON trader_fees(wallet_address, mint, chain, created_at ASC);

-- 3. Add wash-trade cooldown setting to reward_distribution_config
--    Any trade on the same (wallet, mint) pair within this window is ineligible for rewards.
--    Default: 300 seconds (5 minutes).
ALTER TABLE reward_distribution_config
    ADD COLUMN IF NOT EXISTS wash_trade_cooldown_seconds INTEGER NOT NULL DEFAULT 300;
