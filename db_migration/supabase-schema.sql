-- ============================================================================
-- PumpPoly — COMPLETE Supabase schema (greenfield / full reset)
-- ============================================================================
-- Run this single file in the Supabase SQL Editor on a fresh project to create
-- everything the backend needs. It already folds in every migration:
--   • supabase-migration-multi-chain.sql      (chain columns + composite uniques)
--   • supabase-migration-liquidity-lock.sql   (LP lock columns on bonding_curves)
--   • supabase-migration-rewards.sql          (trader_fees.reward_fee + cooldown)
--   • supabase-migration-drop-chain-check.sql (no chain CHECK constraints here)
--   • supabase-migration-token-holders.sql    (token_holders on-chain balance index)
--
-- EXISTING projects: do NOT run this (it assumes empty tables). Apply the
-- individual migration files in date order instead.
--
-- `chain` is a free-form slug: 'solana', 'base', 'polygon', 'bsc', 'eth', 'evm', …
-- Amounts/prices/supplies are stored as TEXT to preserve full uint256 / u64 precision.
-- ============================================================================

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================
-- TOKENS TABLE (multi-chain)
-- ============================================
CREATE TABLE IF NOT EXISTS tokens (
    id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    chain TEXT NOT NULL DEFAULT 'evm',
    token_address TEXT NOT NULL,
    bonding_curve_address TEXT NOT NULL,
    creator TEXT NOT NULL,
    name TEXT NOT NULL,
    symbol TEXT NOT NULL,
    description TEXT DEFAULT '',
    website TEXT DEFAULT '',
    twitter TEXT DEFAULT '',
    telegram TEXT DEFAULT '',
    discord TEXT DEFAULT '',
    logo_url TEXT DEFAULT '',
    banner_url TEXT DEFAULT '',
    total_supply TEXT NOT NULL,
    decimals INTEGER DEFAULT 18,
    transaction_hash TEXT NOT NULL,
    block_number INTEGER NOT NULL,
    timestamp BIGINT NOT NULL,
    initial_price TEXT DEFAULT '0',
    -- Accumulated creator fee awaiting distribution (lamports/wei). Reset to 0 after payout.
    fee_amount TEXT DEFAULT '0',
    price_changed_24h NUMERIC(10, 2),
    status TEXT DEFAULT 'active' CHECK (status IN ('active', 'completed', 'failed')),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (chain, token_address),
    UNIQUE (chain, bonding_curve_address),
    UNIQUE (chain, transaction_hash)
);

-- Indexes for tokens
CREATE INDEX IF NOT EXISTS idx_tokens_creator ON tokens(creator);
CREATE INDEX IF NOT EXISTS idx_tokens_timestamp ON tokens(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_tokens_status ON tokens(status);
CREATE INDEX IF NOT EXISTS idx_tokens_chain ON tokens(chain);

-- ============================================
-- BONDING CURVES TABLE (multi-chain)
-- ============================================
CREATE TABLE IF NOT EXISTS bonding_curves (
    id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    chain TEXT NOT NULL DEFAULT 'evm',
    bonding_curve_address TEXT NOT NULL,
    token_address TEXT NOT NULL,
    creator TEXT NOT NULL,
    virtual_eth_lp TEXT NOT NULL,
    virtual_token_lp TEXT NOT NULL,
    real_eth_lp TEXT DEFAULT '0',
    real_token_lp TEXT DEFAULT '0',
    k TEXT NOT NULL,
    token_start_price TEXT NOT NULL,
    current_price TEXT DEFAULT '0',
    volume TEXT DEFAULT '0',
    total_trades INTEGER DEFAULT 0,
    total_buyers INTEGER DEFAULT 0,
    total_sellers INTEGER DEFAULT 0,
    lp_created BOOLEAN DEFAULT FALSE,
    liquidity_token_id TEXT,
    -- Liquidity lock (chosen at creation; resolved on-chain at finalize/migrate)
    liquidity_lock_duration_seconds TEXT,   -- chosen lock duration in seconds (NULL = none)
    liquidity_unlock_timestamp BIGINT,       -- unix seconds when LP can be withdrawn
    lp_unlocked BOOLEAN DEFAULT FALSE,       -- Solana: migrator claimed LP; EVM: dev called withdrawLiquidity
    start_timestamp BIGINT NOT NULL,
    transaction_hash TEXT NOT NULL,
    block_number INTEGER NOT NULL,
    status TEXT DEFAULT 'active' CHECK (status IN ('active', 'completed', 'failed')),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (chain, bonding_curve_address),
    UNIQUE (chain, transaction_hash)
);

COMMENT ON COLUMN bonding_curves.liquidity_lock_duration_seconds IS 'EVM/Solana: chosen lock duration in seconds at token creation';
COMMENT ON COLUMN bonding_curves.liquidity_unlock_timestamp IS 'Unix seconds when LP can be withdrawn (set at migration/finalize on-chain)';
COMMENT ON COLUMN bonding_curves.lp_unlocked IS 'Solana: migrator claimed LP; EVM: dev called withdrawLiquidity';

-- Indexes for bonding_curves
CREATE INDEX IF NOT EXISTS idx_bonding_curves_token ON bonding_curves(token_address);
CREATE INDEX IF NOT EXISTS idx_bonding_curves_creator ON bonding_curves(creator);
CREATE INDEX IF NOT EXISTS idx_bonding_curves_timestamp ON bonding_curves(start_timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_bonding_curves_volume ON bonding_curves(volume DESC);
CREATE INDEX IF NOT EXISTS idx_bonding_curves_status ON bonding_curves(status);
CREATE INDEX IF NOT EXISTS idx_bonding_curves_chain ON bonding_curves(chain);

-- ============================================
-- CHAT MESSAGES TABLE (Comments)
-- ============================================
CREATE TABLE IF NOT EXISTS chat_messages (
    id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    token_address TEXT NOT NULL,
    sender TEXT NOT NULL,
    content TEXT NOT NULL,
    image_url TEXT DEFAULT '',
    timestamp BIGINT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for chat_messages
CREATE INDEX IF NOT EXISTS idx_chat_token ON chat_messages(token_address);
CREATE INDEX IF NOT EXISTS idx_chat_timestamp ON chat_messages(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_chat_sender ON chat_messages(sender);

-- ============================================
-- TOKEN PRICE DATA TABLE (For Charts)
-- ============================================
CREATE TABLE IF NOT EXISTS token_price_data (
    id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    token_address TEXT NOT NULL,
    timestamp BIGINT NOT NULL,
    open_price TEXT NOT NULL,
    close_price TEXT NOT NULL,
    amount TEXT NOT NULL,
    trader TEXT NOT NULL,
    is_buy BOOLEAN NOT NULL,
    transaction_hash TEXT NOT NULL UNIQUE,
    block_number INTEGER NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for token_price_data
CREATE INDEX IF NOT EXISTS idx_price_token ON token_price_data(token_address);
CREATE INDEX IF NOT EXISTS idx_price_timestamp ON token_price_data(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_price_token_timestamp ON token_price_data(token_address, timestamp DESC);

-- ============================================
-- PROFILES TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS profiles (
    id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    wallet_address TEXT NOT NULL UNIQUE,
    username TEXT,
    bio TEXT DEFAULT '',
    avatar_url TEXT DEFAULT '',
    banner_url TEXT DEFAULT '',
    twitter TEXT DEFAULT '',
    telegram TEXT DEFAULT '',
    website TEXT DEFAULT '',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for profiles
CREATE INDEX IF NOT EXISTS idx_profiles_username ON profiles(username);

-- ============================================
-- TRADE HISTORY TABLE (multi-chain; same tx can exist per chain)
-- ============================================
CREATE TABLE IF NOT EXISTS trade_history (
    id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    chain TEXT NOT NULL DEFAULT 'evm',
    token_address TEXT NOT NULL,
    bonding_curve_address TEXT NOT NULL,
    trader TEXT NOT NULL,
    is_buy BOOLEAN NOT NULL,
    eth_amount TEXT NOT NULL,
    token_amount TEXT NOT NULL,
    price TEXT NOT NULL,
    transaction_hash TEXT NOT NULL,
    block_number INTEGER NOT NULL,
    timestamp BIGINT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (chain, transaction_hash)
);

-- Indexes for trade_history
CREATE INDEX IF NOT EXISTS idx_trades_token ON trade_history(token_address);
CREATE INDEX IF NOT EXISTS idx_trades_trader ON trade_history(trader);
CREATE INDEX IF NOT EXISTS idx_trades_timestamp ON trade_history(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_trades_chain ON trade_history(chain);

-- ============================================
-- TRADER FEES (Solana + EVM; powers the buyer/seller reward pool)
-- One row per trade carrying its fee breakdown. platform_fee / creator_fee /
-- reward_fee are the three pieces of the 1.1% total. reward_fee (0.30%) is the
-- shared pool distributed each epoch; rows are deleted after a distribution round.
-- ============================================
CREATE TABLE IF NOT EXISTS trader_fees (
    id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    wallet_address TEXT NOT NULL,
    mint TEXT NOT NULL,
    trade_type BOOLEAN NOT NULL,            -- true = buy, false = sell
    platform_fee TEXT NOT NULL DEFAULT '0',
    creator_fee TEXT NOT NULL DEFAULT '0',
    reward_fee TEXT NOT NULL DEFAULT '0',   -- 0.30% buyer/seller reward portion
    fee_amount TEXT NOT NULL DEFAULT '0',
    transaction_hash TEXT NOT NULL,
    slot BIGINT,
    block_time BIGINT,
    chain TEXT NOT NULL DEFAULT 'solana',
    claimed BOOLEAN NOT NULL DEFAULT FALSE,
    claimed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (chain, transaction_hash)
);

CREATE INDEX IF NOT EXISTS idx_trader_fees_wallet ON trader_fees(wallet_address);
CREATE INDEX IF NOT EXISTS idx_trader_fees_chain ON trader_fees(chain);
CREATE INDEX IF NOT EXISTS idx_trader_fees_claimed ON trader_fees(claimed) WHERE claimed = FALSE;
-- Composite index for the per-(wallet, mint) wash-trade eligibility window scan
CREATE INDEX IF NOT EXISTS idx_trader_fees_wallet_mint_created
    ON trader_fees(wallet_address, mint, chain, created_at ASC);

-- ============================================
-- REWARD DISTRIBUTION
-- ============================================
CREATE TABLE IF NOT EXISTS reward_distribution_config (
    id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    cycle TEXT NOT NULL DEFAULT '5min',
    reward_ratio DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    next_distribution_at TIMESTAMPTZ NOT NULL,
    minimum_reward_lamports BIGINT NOT NULL DEFAULT 1000,
    -- Trades on the same (wallet, mint) within this window are ineligible (anti-wash-trading)
    wash_trade_cooldown_seconds INTEGER NOT NULL DEFAULT 300,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS reward_distribution_runs (
    id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    distribution_at TIMESTAMPTZ NOT NULL,
    cycle TEXT NOT NULL,
    reward_ratio DOUBLE PRECISION NOT NULL,
    total_fees_lamports TEXT NOT NULL,
    total_rewards_lamports TEXT NOT NULL,
    trader_count INTEGER NOT NULL DEFAULT 0,
    success_count INTEGER NOT NULL DEFAULT 0,
    fail_count INTEGER NOT NULL DEFAULT 0,
    chain TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_reward_runs_distribution_at ON reward_distribution_runs(distribution_at DESC);

-- ============================================
-- TOKEN HOLDERS (on-chain balance index; EVM + Solana)
-- Populated by the backend holder indexer (src/services/holderService.js): EVM via ERC20
-- balanceOf over Transfer-log discovery, Solana via SPL token accounts of the mint. `balance`
-- is raw base units. Bonding curve / pool / zero / dead addresses are excluded by the indexer.
-- ============================================
CREATE TABLE IF NOT EXISTS token_holders (
    id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    chain TEXT NOT NULL,
    token_address TEXT NOT NULL,
    wallet_address TEXT NOT NULL,
    balance TEXT NOT NULL DEFAULT '0',   -- raw base units (string for full precision)
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (chain, token_address, wallet_address)
);

CREATE INDEX IF NOT EXISTS idx_token_holders_token ON token_holders(chain, token_address);
CREATE INDEX IF NOT EXISTS idx_token_holders_wallet ON token_holders(wallet_address);

-- ============================================
-- ENABLE REALTIME FOR TABLES
-- ============================================
ALTER PUBLICATION supabase_realtime ADD TABLE tokens;
ALTER PUBLICATION supabase_realtime ADD TABLE bonding_curves;
ALTER PUBLICATION supabase_realtime ADD TABLE chat_messages;
ALTER PUBLICATION supabase_realtime ADD TABLE token_price_data;
ALTER PUBLICATION supabase_realtime ADD TABLE trade_history;
ALTER PUBLICATION supabase_realtime ADD TABLE profiles;
ALTER PUBLICATION supabase_realtime ADD TABLE token_holders;

-- ============================================
-- ROW LEVEL SECURITY (RLS)
-- ============================================
ALTER TABLE tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE bonding_curves ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE token_price_data ENABLE ROW LEVEL SECURITY;
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE trade_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE trader_fees ENABLE ROW LEVEL SECURITY;
ALTER TABLE reward_distribution_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE reward_distribution_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE token_holders ENABLE ROW LEVEL SECURITY;

-- Public read access (frontend reads directly with the anon key)
CREATE POLICY "Allow public read access" ON tokens FOR SELECT USING (true);
CREATE POLICY "Allow public read access" ON bonding_curves FOR SELECT USING (true);
CREATE POLICY "Allow public read access" ON chat_messages FOR SELECT USING (true);
CREATE POLICY "Allow public read access" ON token_price_data FOR SELECT USING (true);
CREATE POLICY "Allow public read access" ON profiles FOR SELECT USING (true);
CREATE POLICY "Allow public read access" ON trade_history FOR SELECT USING (true);
CREATE POLICY "Allow public read access" ON token_holders FOR SELECT USING (true);

-- Trader fees & reward tables: backend (service role) only — no public policies.

-- Allow anonymous users to insert chat messages (comments)
CREATE POLICY "Allow anonymous insert chat messages" ON chat_messages FOR INSERT WITH CHECK (true);

-- Allow anonymous users to insert profiles (for profile creation)
CREATE POLICY "Allow anonymous insert profiles" ON profiles FOR INSERT WITH CHECK (true);

-- Allow anonymous users to update profiles (for profile editing)
-- Note: In production, you may want to add wallet address validation.
CREATE POLICY "Allow anonymous update own profile" ON profiles FOR UPDATE
  USING (true)
  WITH CHECK (true);

-- Service role full access (backend ingestion / distribution)
CREATE POLICY "Allow service role full access" ON tokens FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "Allow service role full access" ON bonding_curves FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "Allow service role full access" ON chat_messages FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "Allow service role full access" ON token_price_data FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "Allow service role full access" ON profiles FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "Allow service role full access" ON trade_history FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "Allow service role full access" ON trader_fees FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "Allow service role full access" ON reward_distribution_config FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "Allow service role full access" ON reward_distribution_runs FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "Allow service role full access" ON token_holders FOR ALL USING (auth.role() = 'service_role');

-- ============================================
-- updated_at TRIGGER
-- ============================================
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_tokens_updated_at BEFORE UPDATE ON tokens
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_bonding_curves_updated_at BEFORE UPDATE ON bonding_curves
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_profiles_updated_at BEFORE UPDATE ON profiles
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_reward_distribution_config_updated_at BEFORE UPDATE ON reward_distribution_config
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
