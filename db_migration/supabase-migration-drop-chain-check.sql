-- Remove CHECK constraints that limited `chain` to ('evm','solana').
-- Run in Supabase SQL Editor if you already applied an older supabase-migration-multi-chain.sql
-- that added tokens_chain_check / bonding_curves_chain_check / etc.

ALTER TABLE tokens DROP CONSTRAINT IF EXISTS tokens_chain_check;
ALTER TABLE bonding_curves DROP CONSTRAINT IF EXISTS bonding_curves_chain_check;
ALTER TABLE trade_history DROP CONSTRAINT IF EXISTS trade_history_chain_check;
ALTER TABLE trader_fees DROP CONSTRAINT IF EXISTS trader_fees_chain_check;
