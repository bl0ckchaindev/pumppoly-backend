-- Supabase Schema for Base PumpFun
-- Run this SQL in your Supabase SQL Editor to create the required tables

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================
-- TOKENS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS tokens (
    id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    token_address TEXT NOT NULL UNIQUE,
    bonding_curve_address TEXT NOT NULL UNIQUE,
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
    transaction_hash TEXT NOT NULL UNIQUE,
    block_number INTEGER NOT NULL,
    timestamp BIGINT NOT NULL,
    initial_price TEXT DEFAULT '0',
    fee_amount TEXT DEFAULT '0',
    price_changed_24h NUMERIC(10, 2),
    status TEXT DEFAULT 'active' CHECK (status IN ('active', 'completed', 'failed')),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for tokens
CREATE INDEX IF NOT EXISTS idx_tokens_creator ON tokens(creator);
CREATE INDEX IF NOT EXISTS idx_tokens_timestamp ON tokens(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_tokens_status ON tokens(status);

-- ============================================
-- BONDING CURVES TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS bonding_curves (
    id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    bonding_curve_address TEXT NOT NULL UNIQUE,
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
    start_timestamp BIGINT NOT NULL,
    transaction_hash TEXT NOT NULL UNIQUE,
    block_number INTEGER NOT NULL,
    status TEXT DEFAULT 'active' CHECK (status IN ('active', 'completed', 'failed')),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for bonding_curves
CREATE INDEX IF NOT EXISTS idx_bonding_curves_token ON bonding_curves(token_address);
CREATE INDEX IF NOT EXISTS idx_bonding_curves_creator ON bonding_curves(creator);
CREATE INDEX IF NOT EXISTS idx_bonding_curves_timestamp ON bonding_curves(start_timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_bonding_curves_volume ON bonding_curves(volume DESC);
CREATE INDEX IF NOT EXISTS idx_bonding_curves_status ON bonding_curves(status);

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
    twitter TEXT DEFAULT '',
    telegram TEXT DEFAULT '',
    website TEXT DEFAULT '',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for profiles
CREATE INDEX IF NOT EXISTS idx_profiles_username ON profiles(username);

-- ============================================
-- TRADE HISTORY TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS trade_history (
    id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    token_address TEXT NOT NULL,
    bonding_curve_address TEXT NOT NULL,
    trader TEXT NOT NULL,
    is_buy BOOLEAN NOT NULL,
    eth_amount TEXT NOT NULL,
    token_amount TEXT NOT NULL,
    price TEXT NOT NULL,
    transaction_hash TEXT NOT NULL UNIQUE,
    block_number INTEGER NOT NULL,
    timestamp BIGINT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for trade_history
CREATE INDEX IF NOT EXISTS idx_trades_token ON trade_history(token_address);
CREATE INDEX IF NOT EXISTS idx_trades_trader ON trade_history(trader);
CREATE INDEX IF NOT EXISTS idx_trades_timestamp ON trade_history(timestamp DESC);

-- ============================================
-- ENABLE REALTIME FOR TABLES
-- ============================================
-- Enable realtime for tokens (token creation/updates)
ALTER PUBLICATION supabase_realtime ADD TABLE tokens;

-- Enable realtime for bonding_curves (price/volume updates)
ALTER PUBLICATION supabase_realtime ADD TABLE bonding_curves;

-- Enable realtime for chat_messages (comments)
ALTER PUBLICATION supabase_realtime ADD TABLE chat_messages;

-- Enable realtime for token_price_data (price charts)
ALTER PUBLICATION supabase_realtime ADD TABLE token_price_data;

-- Enable realtime for trade_history (trades)
ALTER PUBLICATION supabase_realtime ADD TABLE trade_history;

-- Enable realtime for profiles (profile updates)
ALTER PUBLICATION supabase_realtime ADD TABLE profiles;

-- ============================================
-- ROW LEVEL SECURITY (RLS)
-- ============================================
-- Enable RLS on all tables
ALTER TABLE tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE bonding_curves ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE token_price_data ENABLE ROW LEVEL SECURITY;
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE trade_history ENABLE ROW LEVEL SECURITY;

-- Allow public read access to all tables
CREATE POLICY "Allow public read access" ON tokens FOR SELECT USING (true);
CREATE POLICY "Allow public read access" ON bonding_curves FOR SELECT USING (true);
CREATE POLICY "Allow public read access" ON chat_messages FOR SELECT USING (true);
CREATE POLICY "Allow public read access" ON token_price_data FOR SELECT USING (true);
CREATE POLICY "Allow public read access" ON profiles FOR SELECT USING (true);
CREATE POLICY "Allow public read access" ON trade_history FOR SELECT USING (true);

-- Allow anonymous users to insert chat messages (comments)
CREATE POLICY "Allow anonymous insert chat messages" ON chat_messages FOR INSERT WITH CHECK (true);

-- Allow anonymous users to insert profiles (for profile creation)
CREATE POLICY "Allow anonymous insert profiles" ON profiles FOR INSERT WITH CHECK (true);

-- Allow anonymous users to update profiles (for profile editing)
-- Note: In production, you may want to add wallet address validation
CREATE POLICY "Allow anonymous update own profile" ON profiles FOR UPDATE 
  USING (true)
  WITH CHECK (true);

-- Allow service role full access (for backend)
CREATE POLICY "Allow service role full access" ON tokens FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "Allow service role full access" ON bonding_curves FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "Allow service role full access" ON chat_messages FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "Allow service role full access" ON token_price_data FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "Allow service role full access" ON profiles FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "Allow service role full access" ON trade_history FOR ALL USING (auth.role() = 'service_role');

-- ============================================
-- FUNCTIONS FOR UPDATED_AT TRIGGER
-- ============================================
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Apply trigger to tables with updated_at
CREATE TRIGGER update_tokens_updated_at BEFORE UPDATE ON tokens
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_bonding_curves_updated_at BEFORE UPDATE ON bonding_curves
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_profiles_updated_at BEFORE UPDATE ON profiles
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

