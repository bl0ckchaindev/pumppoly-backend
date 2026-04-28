-- Multi-chain migration for existing Supabase projects (EVM + Solana).
-- Run once in Supabase Dashboard → SQL Editor.
--
-- Adds: tokens.chain, bonding_curves.chain, trade_history.chain with composite uniques;
-- creates trader_fees, reward_distribution_config, reward_distribution_runs if missing.
--
-- After this, `chain` is a free-form slug (e.g. solana, base, polygon, bsc, eth, evm).

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ---------------------------------------------------------------------------
-- 1) TOKENS
-- ---------------------------------------------------------------------------
ALTER TABLE tokens ADD COLUMN IF NOT EXISTS chain TEXT DEFAULT 'evm';

UPDATE tokens SET chain = 'evm' WHERE chain IS NULL OR trim(chain) = '';

ALTER TABLE tokens ALTER COLUMN chain SET NOT NULL;
ALTER TABLE tokens ALTER COLUMN chain SET DEFAULT 'evm';

ALTER TABLE tokens DROP CONSTRAINT IF EXISTS tokens_token_address_key;
ALTER TABLE tokens DROP CONSTRAINT IF EXISTS tokens_bonding_curve_address_key;
ALTER TABLE tokens DROP CONSTRAINT IF EXISTS tokens_transaction_hash_key;

DO $$ BEGIN
  ALTER TABLE tokens ADD CONSTRAINT tokens_chain_token_address_key UNIQUE (chain, token_address);
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE tokens ADD CONSTRAINT tokens_chain_bonding_curve_address_key UNIQUE (chain, bonding_curve_address);
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE tokens ADD CONSTRAINT tokens_chain_transaction_hash_key UNIQUE (chain, transaction_hash);
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_tokens_chain ON tokens(chain);

-- ---------------------------------------------------------------------------
-- 2) BONDING_CURVES
-- ---------------------------------------------------------------------------
ALTER TABLE bonding_curves ADD COLUMN IF NOT EXISTS chain TEXT DEFAULT 'evm';

UPDATE bonding_curves SET chain = 'evm' WHERE chain IS NULL OR trim(chain) = '';

ALTER TABLE bonding_curves ALTER COLUMN chain SET NOT NULL;
ALTER TABLE bonding_curves ALTER COLUMN chain SET DEFAULT 'evm';

ALTER TABLE bonding_curves DROP CONSTRAINT IF EXISTS bonding_curves_bonding_curve_address_key;
ALTER TABLE bonding_curves DROP CONSTRAINT IF EXISTS bonding_curves_transaction_hash_key;

DO $$ BEGIN
  ALTER TABLE bonding_curves ADD CONSTRAINT bonding_curves_chain_bonding_curve_address_key UNIQUE (chain, bonding_curve_address);
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE bonding_curves ADD CONSTRAINT bonding_curves_chain_transaction_hash_key UNIQUE (chain, transaction_hash);
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_bonding_curves_chain ON bonding_curves(chain);

-- ---------------------------------------------------------------------------
-- 3) TRADE_HISTORY
-- ---------------------------------------------------------------------------
ALTER TABLE trade_history ADD COLUMN IF NOT EXISTS chain TEXT DEFAULT 'evm';

UPDATE trade_history SET chain = 'evm' WHERE chain IS NULL OR trim(chain) = '';

ALTER TABLE trade_history ALTER COLUMN chain SET NOT NULL;
ALTER TABLE trade_history ALTER COLUMN chain SET DEFAULT 'evm';

ALTER TABLE trade_history DROP CONSTRAINT IF EXISTS trade_history_transaction_hash_key;

DO $$ BEGIN
  ALTER TABLE trade_history ADD CONSTRAINT trade_history_chain_transaction_hash_key UNIQUE (chain, transaction_hash);
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_trades_chain ON trade_history(chain);

-- ---------------------------------------------------------------------------
-- 4) TRADER_FEES (create or upgrade)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS trader_fees (
    id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    wallet_address TEXT NOT NULL,
    mint TEXT NOT NULL,
    trade_type BOOLEAN NOT NULL,
    platform_fee TEXT NOT NULL DEFAULT '0',
    creator_fee TEXT NOT NULL DEFAULT '0',
    fee_amount TEXT NOT NULL DEFAULT '0',
    transaction_hash TEXT NOT NULL,
    slot BIGINT,
    block_time BIGINT,
    chain TEXT DEFAULT 'solana',
    claimed BOOLEAN NOT NULL DEFAULT FALSE,
    claimed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE trader_fees ADD COLUMN IF NOT EXISTS chain TEXT DEFAULT 'solana';
ALTER TABLE trader_fees ADD COLUMN IF NOT EXISTS claimed BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE trader_fees ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ;
ALTER TABLE trader_fees ADD COLUMN IF NOT EXISTS slot BIGINT;
ALTER TABLE trader_fees ADD COLUMN IF NOT EXISTS block_time BIGINT;

UPDATE trader_fees
SET chain = CASE WHEN trim(wallet_address) LIKE '0x%' THEN 'evm' ELSE 'solana' END
WHERE chain IS NULL OR trim(chain) = '';

ALTER TABLE trader_fees ALTER COLUMN chain SET NOT NULL;

ALTER TABLE trader_fees DROP CONSTRAINT IF EXISTS trader_fees_transaction_hash_key;

DO $$ BEGIN
  ALTER TABLE trader_fees ADD CONSTRAINT trader_fees_chain_transaction_hash_key UNIQUE (chain, transaction_hash);
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_trader_fees_wallet ON trader_fees(wallet_address);
CREATE INDEX IF NOT EXISTS idx_trader_fees_chain ON trader_fees(chain);
CREATE INDEX IF NOT EXISTS idx_trader_fees_claimed ON trader_fees(claimed) WHERE claimed = FALSE;

-- ---------------------------------------------------------------------------
-- 5) REWARD DISTRIBUTION TABLES
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS reward_distribution_config (
    id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    cycle TEXT NOT NULL DEFAULT '5min',
    reward_ratio DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    next_distribution_at TIMESTAMPTZ NOT NULL,
    minimum_reward_lamports BIGINT NOT NULL DEFAULT 1000,
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

ALTER TABLE reward_distribution_runs ADD COLUMN IF NOT EXISTS chain TEXT;

CREATE INDEX IF NOT EXISTS idx_reward_runs_distribution_at ON reward_distribution_runs(distribution_at DESC);

-- ---------------------------------------------------------------------------
-- 6) RLS (service role only for new tables)
-- ---------------------------------------------------------------------------
ALTER TABLE trader_fees ENABLE ROW LEVEL SECURITY;
ALTER TABLE reward_distribution_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE reward_distribution_runs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow service role full access" ON trader_fees;
CREATE POLICY "Allow service role full access" ON trader_fees FOR ALL USING (auth.role() = 'service_role');

DROP POLICY IF EXISTS "Allow service role full access" ON reward_distribution_config;
CREATE POLICY "Allow service role full access" ON reward_distribution_config FOR ALL USING (auth.role() = 'service_role');

DROP POLICY IF EXISTS "Allow service role full access" ON reward_distribution_runs;
CREATE POLICY "Allow service role full access" ON reward_distribution_runs FOR ALL USING (auth.role() = 'service_role');

-- ---------------------------------------------------------------------------
-- 7) updated_at trigger for reward_distribution_config
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS update_reward_distribution_config_updated_at ON reward_distribution_config;
CREATE TRIGGER update_reward_distribution_config_updated_at
    BEFORE UPDATE ON reward_distribution_config
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
