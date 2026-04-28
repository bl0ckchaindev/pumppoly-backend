-- Optional: add LP lock columns to bonding_curves (run in Supabase SQL editor)
ALTER TABLE bonding_curves
  ADD COLUMN IF NOT EXISTS liquidity_lock_duration_seconds TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS liquidity_unlock_timestamp BIGINT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS lp_unlocked BOOLEAN DEFAULT FALSE;

COMMENT ON COLUMN bonding_curves.liquidity_lock_duration_seconds IS 'EVM/Solana: chosen lock duration in seconds at token creation';
COMMENT ON COLUMN bonding_curves.liquidity_unlock_timestamp IS 'Unix seconds when LP can be withdrawn (set at migration/finalize on-chain)';
COMMENT ON COLUMN bonding_curves.lp_unlocked IS 'Solana: migrator claimed LP; EVM: dev called withdrawLiquidity';
