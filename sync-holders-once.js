#!/usr/bin/env node
/**
 * One-shot holder index population. Run AFTER applying
 * db_migration/supabase-migration-token-holders.sql. Does a full holder sync for every active
 * token (the cron job then keeps them fresh every 2 min). Safe to re-run (idempotent upserts).
 *
 *   node sync-holders-once.js
 */
require('dotenv').config();
const supabaseService = require('./src/services/supabaseService');
const holderService = require('./src/services/holderService');
const { getEvmChainSlug } = require('./src/lib/chainUtils');

async function main() {
  // Fail fast with a clear message if the table isn't there yet.
  try {
    await supabaseService.getTokenHolders(getEvmChainSlug(), '0x0', 1);
  } catch (e) { /* getTokenHolders swallows errors; check via a direct probe below */ }

  const evm = await supabaseService.getActiveTokensForHolderSync(getEvmChainSlug());
  console.log(`EVM tokens to index: ${evm.length}`);
  for (const t of evm) {
    await holderService.syncEvmHolders(t.tokenAddress, t.bondingCurveAddress, t.chain, t.blockNumber);
  }

  const sol = await supabaseService.getActiveTokensForHolderSync('solana');
  console.log(`Solana tokens to index: ${sol.length}`);
  for (const t of sol) {
    await holderService.syncSolanaHolders(t.tokenAddress, t.chain);
  }

  console.log('\n── Holder counts ──');
  for (const t of [...evm, ...sol]) {
    const h = await supabaseService.getTokenHolders(t.chain, t.tokenAddress);
    console.log(`${t.chain.padEnd(8)} ${t.tokenAddress}: ${h.length} holder(s)`);
  }
  console.log('\nDone.');
}

main().then(() => process.exit(0)).catch((e) => { console.error('Failed:', e.message); process.exit(1); });
