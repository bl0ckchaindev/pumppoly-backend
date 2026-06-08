#!/usr/bin/env node
/**
 * One-off cleanup for the EVM chain-slug mismatch.
 *
 * Before EVM_CHAIN_SLUG was set, the event listener wrote rows under chain='evm' while the frontend
 * wrote the same token under chain='sepolia', creating duplicate (token / bonding_curve) rows that
 * broke the token page (maybeSingle() errors on >1 row). This canonicalises everything to 'sepolia':
 *
 *   tokens         : keep the canonical row (frontend metadata/logo); drop the 'evm' duplicate.
 *   bonding_curves : keep the 'evm' row (it has the live reserves from trades); drop the stale
 *                    canonical row, then re-slug the 'evm' row to 'sepolia'.
 *   trade_history  : re-slug 'evm' -> 'sepolia'; drop the 'evm' row if a canonical tx dup exists.
 *   trader_fees    : same as trade_history.
 *
 * Idempotent — after a clean run there are no 'evm' rows left, so re-running is a no-op.
 * Run AFTER setting EVM_CHAIN_SLUG=sepolia and restarting the backend (so it can't recreate 'evm').
 *
 *   node reconcile-chain-slug.js
 */
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
const OLD = 'evm';
const CANON = (process.env.EVM_CHAIN_SLUG || 'sepolia').toLowerCase();

async function main() {
  if (CANON === OLD) throw new Error(`EVM_CHAIN_SLUG is '${OLD}' — set it to the canonical slug (e.g. sepolia) first`);
  console.log(`Reconciling chain '${OLD}' -> '${CANON}'\n`);

  // 1) tokens — keep canonical (has logo/socials), drop the 'evm' duplicate; else re-slug.
  const { data: evmTokens = [] } = await sb.from('tokens').select('id,token_address').eq('chain', OLD);
  for (const t of evmTokens) {
    const { data: canon } = await sb.from('tokens').select('id').eq('chain', CANON).eq('token_address', t.token_address).maybeSingle();
    if (canon) {
      await sb.from('tokens').delete().eq('id', t.id);
      console.log('tokens         : dropped evm dup', t.token_address);
    } else {
      await sb.from('tokens').update({ chain: CANON }).eq('id', t.id);
      console.log('tokens         : reslugged', t.token_address);
    }
  }

  // 2) bonding_curves — keep the 'evm' row (live reserves), drop stale canonical, then re-slug.
  const { data: evmBcs = [] } = await sb.from('bonding_curves').select('id,bonding_curve_address').eq('chain', OLD);
  for (const bc of evmBcs) {
    await sb.from('bonding_curves').delete().eq('chain', CANON).eq('bonding_curve_address', bc.bonding_curve_address);
    await sb.from('bonding_curves').update({ chain: CANON }).eq('id', bc.id);
    console.log('bonding_curves : kept live evm row ->', CANON, bc.bonding_curve_address);
  }

  // 3) trade_history & trader_fees — re-slug; drop 'evm' row on tx conflict.
  for (const table of ['trade_history', 'trader_fees']) {
    const { data: rows = [] } = await sb.from(table).select('id,transaction_hash').eq('chain', OLD);
    for (const r of rows) {
      const { data: dup } = await sb.from(table).select('id').eq('chain', CANON).eq('transaction_hash', r.transaction_hash).maybeSingle();
      if (dup) {
        await sb.from(table).delete().eq('id', r.id);
        console.log(`${table.padEnd(15)}: dropped evm dup`, r.transaction_hash);
      } else {
        await sb.from(table).update({ chain: CANON }).eq('id', r.id);
        console.log(`${table.padEnd(15)}: reslugged`, r.transaction_hash);
      }
    }
  }

  // Summary
  for (const t of ['tokens', 'bonding_curves', 'trade_history', 'trader_fees']) {
    const { count } = await sb.from(t).select('id', { count: 'exact', head: true }).eq('chain', OLD);
    console.log(`remaining '${OLD}' rows in ${t}:`, count ?? 0);
  }
  console.log('\nDone.');
}

main().then(() => process.exit(0)).catch((e) => { console.error('Failed:', e.message); process.exit(1); });
