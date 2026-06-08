-- ============================================================================
-- token_holders — on-chain holder balance index (per token, per wallet)
-- ============================================================================
-- Populated by the backend holder indexer (src/services/holderService.js) which
-- reads balances directly from chain (ERC20 balanceOf for EVM, SPL token accounts
-- for Solana) and upserts them here. `balance` is raw base units (wei / 6-dec / etc).
-- The bonding curve / pool / zero / dead addresses are excluded by the indexer.
-- ============================================================================

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

-- Frontend reads holders directly with the anon key.
ALTER TABLE token_holders ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow public read access" ON token_holders;
CREATE POLICY "Allow public read access" ON token_holders FOR SELECT USING (true);
DROP POLICY IF EXISTS "Allow service role full access" ON token_holders;
CREATE POLICY "Allow service role full access" ON token_holders FOR ALL USING (auth.role() = 'service_role');

-- Live holder updates on the token page (idempotent — safe to re-run).
DO $$ BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE token_holders;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
