#!/usr/bin/env node
/**
 * One-time role handover for the Solana global config.
 *
 * Sets owner / migrator / fee_recipient to the final PumpPoly wallets (and re-applies the
 * production fees + graduation threshold). `update_config` requires the signer to be the CURRENT
 * config owner, so:
 *   SOLANA_TREASURY_PRIVATE_KEY  = the CURRENT owner's key (signs this tx)
 *
 * Run AFTER init-solana-config.js. Example flow:
 *   1. init-solana-config.js signed by the owner wallet  -> owner = migrator = owner, fee_recipient set
 *   2. this script                                        -> migrator -> its own wallet (owner unchanged)
 * Or init with a temporary deployer, then this script hands owner + migrator + fee_recipient to the
 * final wallets in one tx (after which the temporary deployer loses control).
 *
 * Env (base58 Solana addresses):
 *   SOLANA_CONFIG_OWNER    new owner / admin wallet
 *   SOLANA_MIGRATOR        migrator wallet (may call migrate / unlock_lp)
 *   SOLANA_FEE_RECIPIENT   fee receiver wallet (receives protocol fees)
 *   (optional fee/threshold overrides, else production defaults below)
 */
require('dotenv').config();
const solanaService = require('./src/services/solanaService');

const DEFAULTS = {
  protocolFeeBps: 35,
  creatorFeeBps: 45,
  rewardFeeBps: 30,
  creatorMigrateFeeBps: 10,
  protocolMigrateFeeBps: 15,
  realSolThresholdLamports: '85000000000', // 85 SOL
};
const n = (envName, def) => (process.env[envName] !== undefined ? Number(process.env[envName]) : def);

async function main() {
  const owner = (process.env.SOLANA_CONFIG_OWNER || '').trim();
  const migrator = (process.env.SOLANA_MIGRATOR || '').trim();
  const feeRecipient = (process.env.SOLANA_FEE_RECIPIENT || '').trim();
  if (!owner || !migrator || !feeRecipient) {
    throw new Error('Set SOLANA_CONFIG_OWNER, SOLANA_MIGRATOR, and SOLANA_FEE_RECIPIENT (base58 addresses).');
  }

  const params = {
    owner,
    migrator,
    feeRecipient,
    protocolFeeBps: n('PROTOCOL_FEE_BPS', DEFAULTS.protocolFeeBps),
    creatorFeeBps: n('CREATOR_FEE_BPS', DEFAULTS.creatorFeeBps),
    rewardFeeBps: n('REWARD_FEE_BPS', DEFAULTS.rewardFeeBps),
    creatorMigrateFeeBps: n('CREATOR_MIGRATE_FEE_BPS', DEFAULTS.creatorMigrateFeeBps),
    protocolMigrateFeeBps: n('PROTOCOL_MIGRATE_FEE_BPS', DEFAULTS.protocolMigrateFeeBps),
    realSolThreshold: String(process.env.REAL_SOL_THRESHOLD_LAMPORTS ?? DEFAULTS.realSolThresholdLamports),
  };

  console.log('Handing over Solana global-config roles:');
  console.log('  owner (admin)  :', owner);
  console.log('  migrator       :', migrator);
  console.log('  fee_recipient  :', feeRecipient);
  console.log('  fees p/c/r bps :', params.protocolFeeBps, '/', params.creatorFeeBps, '/', params.rewardFeeBps);
  console.log('  threshold      :', params.realSolThreshold, `(${Number(params.realSolThreshold) / 1e9} SOL)`);
  console.log('  signer         : SOLANA_TREASURY_PRIVATE_KEY (must be the CURRENT owner)');
  console.log('  ⚠ After this tx the NEW owner controls the config; the current signer loses owner rights if it differs.\n');

  const sig = await solanaService.updateGlobalConfig(params);
  console.log('✅ Roles updated. Signature:', sig);
}

main().then(() => process.exit(0)).catch((e) => {
  console.error('\n❌ Role handover failed:', (e && e.message) ? e.message : e);
  process.exit(1);
});
