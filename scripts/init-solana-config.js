#!/usr/bin/env node
/**
 * One-time Solana global-config initialization for the `fomo` program.
 *
 * Run this ONCE, AFTER:
 *   1. `anchor build` + `anchor deploy --provider.cluster devnet`
 *   2. copying the freshly built IDL to backend/src/idl/fomo.json (it must contain reward_fee_bps)
 *
 * Requires in backend/.env:
 *   SOLANA_RPC_URL              devnet RPC (e.g. https://api.devnet.solana.com)
 *   SOLANA_TREASURY_PRIVATE_KEY JSON array of 64 numbers — becomes the config OWNER + MIGRATOR.
 *                               This wallet must hold some devnet SOL to pay for the init accounts.
 *
 * All values are overridable via env vars (see DEFAULTS). Trade fees mirror the EVM split
 * (protocol 0.35% / creator 0.45% / reward 0.30% = 1.1%). The graduation threshold defaults to the
 * PRODUCTION value (85 SOL). For devnet testing, set REAL_SOL_THRESHOLD_LAMPORTS to a small value
 * (e.g. 5000000000 = 5 SOL). A mainnet RPC REFUSES a sub-10 SOL threshold (guard below), so a
 * missing or stale devnet value can never accidentally initialize mainnet at 5 SOL.
 *
 * Usage:
 *   node scripts/init-solana-config.js
 *   REAL_SOL_THRESHOLD_LAMPORTS=1000000000 node scripts/init-solana-config.js   # graduate at 1 SOL
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const solanaService = require('../src/services/solanaService');

// Caps enforced on-chain: total trade fee <= 200 bps, total migrate fee <= 500 bps.
const DEFAULTS = {
  protocolFeeBps: 35,                        // 0.35% platform
  creatorFeeBps: 45,                         // 0.45% creator
  rewardFeeBps: 30,                          // 0.30% trader rewards   (total 110 bps = 1.1%)
  creatorMigrateFeeBps: 10,                  // 0.10% at migration
  protocolMigrateFeeBps: 15,                 // 0.15% at migration      (total 25 bps)
  realSolThresholdLamports: '85000000000',   // 85 SOL — PRODUCTION graduation threshold
};

const n = (envName, def) => (process.env[envName] !== undefined ? Number(process.env[envName]) : def);

async function main() {
  const params = {
    // fee_recipient = treasury that RECEIVES protocol fees. Set FEE_RECIPIENT to the final fee
    // wallet; if omitted it defaults to the signer (owner). owner + migrator are set to the SIGNER
    // (SOLANA_TREASURY_PRIVATE_KEY) by initialize_config — sign with the owner wallet, then run
    // set-solana-roles.js to point the migrator at its own wallet.
    feeRecipient: process.env.FEE_RECIPIENT || undefined,
    protocolFeeBps: n('PROTOCOL_FEE_BPS', DEFAULTS.protocolFeeBps),
    creatorFeeBps: n('CREATOR_FEE_BPS', DEFAULTS.creatorFeeBps),
    rewardFeeBps: n('REWARD_FEE_BPS', DEFAULTS.rewardFeeBps),
    creatorMigrateFeeBps: n('CREATOR_MIGRATE_FEE_BPS', DEFAULTS.creatorMigrateFeeBps),
    protocolMigrateFeeBps: n('PROTOCOL_MIGRATE_FEE_BPS', DEFAULTS.protocolMigrateFeeBps),
    realSolThreshold: String(process.env.REAL_SOL_THRESHOLD_LAMPORTS ?? DEFAULTS.realSolThresholdLamports),
  };

  const totalTrade = params.protocolFeeBps + params.creatorFeeBps + params.rewardFeeBps;
  const totalMigrate = params.creatorMigrateFeeBps + params.protocolMigrateFeeBps;

  console.log('Initializing Solana global config');
  console.log('  RPC                          :', process.env.SOLANA_RPC_URL || '(SOLANA_RPC_URL not set!)');
  console.log('  fee_recipient                :', params.feeRecipient || '(defaults to owner/signer)');
  console.log('  protocol/creator/reward bps  :', params.protocolFeeBps, '/', params.creatorFeeBps, '/', params.rewardFeeBps, `(total ${totalTrade}, max 200)`);
  console.log('  migrate creator/protocol bps :', params.creatorMigrateFeeBps, '/', params.protocolMigrateFeeBps, `(total ${totalMigrate}, max 500)`);
  console.log('  real SOL threshold (lamports):', params.realSolThreshold, `(${Number(params.realSolThreshold) / 1e9} SOL)`);

  if (![params.protocolFeeBps, params.creatorFeeBps, params.rewardFeeBps, params.creatorMigrateFeeBps, params.protocolMigrateFeeBps].every(Number.isInteger)) {
    throw new Error('All *_FEE_BPS values must be integers');
  }
  if (totalTrade > 200) throw new Error(`trade fee total ${totalTrade} bps exceeds on-chain max of 200`);
  if (totalMigrate > 500) throw new Error(`migrate fee total ${totalMigrate} bps exceeds on-chain max of 500`);
  if (!/^\d+$/.test(params.realSolThreshold)) throw new Error('REAL_SOL_THRESHOLD_LAMPORTS must be a non-negative integer (lamports)');

  // Mainnet safety: never let a missing/stale devnet threshold initialize a real mainnet config.
  const rpc = (process.env.SOLANA_RPC_URL || '').toLowerCase();
  const isMainnet = rpc.includes('mainnet') && !rpc.includes('devnet') && !rpc.includes('testnet');
  const MAINNET_MIN_LAMPORTS = 10_000_000_000n; // 10 SOL floor — blocks obvious test values (e.g. 5 SOL)
  if (isMainnet) {
    console.log('  network                      : MAINNET (detected from SOLANA_RPC_URL)');
    if (BigInt(params.realSolThreshold) < MAINNET_MIN_LAMPORTS) {
      throw new Error(
        `Refusing to initialize a MAINNET config with a ${Number(params.realSolThreshold) / 1e9} SOL graduation ` +
        `threshold. Set REAL_SOL_THRESHOLD_LAMPORTS explicitly (production = 85 SOL = 85000000000).`
      );
    }
  }

  try {
    const sig = await solanaService.initializeConfig(params);
    console.log('\n✅ Global config initialized.');
    console.log('   Signature        :', sig);
    console.log('   Global config PDA:', solanaService.getGlobalConfigPDA().toBase58());
  } catch (e) {
    const msg = (e && e.message) ? e.message : String(e);
    if (/already.*initialized|ConfigAlreadyInitialized|already in use|custom program error: 0x0\b/i.test(msg)) {
      console.log('\nℹ Global config already initialized — nothing to do.');
      console.log('  To change values, POST /update-global-config or call solanaService.updateGlobalConfig().');
      return;
    }
    throw e;
  }
}

main().then(() => process.exit(0)).catch((e) => {
  console.error('\n❌ Init failed:', (e && e.message) ? e.message : e);
  process.exit(1);
});
