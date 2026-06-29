-- Per-wallet cumulative reward claim tracking.
--
-- This is the source of truth for "how much a wallet has already withdrawn" on Solana, so the
-- double-claim lock survives backend restarts (no in-memory state). EVM tracks claimed on-chain in
-- the RewardClaim contract, but both chains use the SAME amount basis: cumulative reward_fee minus
-- already-claimed.
--
-- Run this once against your Supabase database.

create table if not exists reward_claims (
    id                bigint generated always as identity primary key,
    chain             text        not null,
    wallet            text        not null,
    claimed_amount    text        not null default '0',  -- cumulative lamports/wei already claimed
    pending_amount    text,                              -- in-flight claim amount (null when none)
    pending_signature text,                              -- tx signature once the user submits
    pending_expires_at timestamptz,                      -- in-flight lock expiry
    updated_at        timestamptz not null default now(),
    constraint reward_claims_chain_wallet_unique unique (chain, wallet)
);

create index if not exists reward_claims_chain_wallet_idx on reward_claims (chain, wallet);
