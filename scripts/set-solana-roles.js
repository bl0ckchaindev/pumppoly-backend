#!/usr/bin/env node
/**
 * Role / config update for the Solana global config (owner-signed, client-run).
 *
 * Sets owner / migrator / fee_recipient (and re-applies the production fees + graduation
 * threshold). `update_config` requires the signer to be the CURRENT config owner, so pass the
 * owner's key inline for this one run (never store it in .env):
 *   SOLANA_OWNER_PRIVATE_KEY   the CURRENT owner's private key (base58 or JSON array)
 *
 * Target values come from env (base58 Solana addresses — the standing values in .env are fine):
 *   SOLANA_CONFIG_OWNER    owner / admin wallet (pass the current one to keep it unchanged)
 *   SOLANA_MIGRATOR        migrator wallet (may call migrate / unlock_lp)
 *   SOLANA_FEE_RECIPIENT   fee receiver wallet (where claim_protocol_fee sweeps land)
 *   (optional fee/threshold overrides, else production defaults below)
 *
 * Usage (bash):
 *   read -s -p "Owner key: " SOLANA_OWNER_PRIVATE_KEY && export SOLANA_OWNER_PRIVATE_KEY
 *   node scripts/set-solana-roles.js
 *   unset SOLANA_OWNER_PRIVATE_KEY
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Keypair } = require('@solana/web3.js');
const bs58 = require('bs58');
const solanaService = require('../src/services/solanaService');

function loadOwnerKeypair() {
  const s = (process.env.SOLANA_OWNER_PRIVATE_KEY || '').trim();
  if (!s) throw new Error('SOLANA_OWNER_PRIVATE_KEY is not set (pass it inline; do not store it in .env)');
  try {
    const arr = JSON.parse(s);
    if (Array.isArray(arr)) return Keypair.fromSecretKey(Uint8Array.from(arr));
  } catch { /* not JSON — try base58 */ }
  return Keypair.fromSecretKey(bs58.decode(s));
}

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

  const ownerKeypair = loadOwnerKeypair();

  console.log('Updating Solana global-config roles:');
  console.log('  owner (admin)  :', owner);
  console.log('  migrator       :', migrator);
  console.log('  fee_recipient  :', feeRecipient);
  console.log('  fees p/c/r bps :', params.protocolFeeBps, '/', params.creatorFeeBps, '/', params.rewardFeeBps);
  console.log('  threshold      :', params.realSolThreshold, `(${Number(params.realSolThreshold) / 1e9} SOL)`);
  console.log('  signer         :', ownerKeypair.publicKey.toBase58(), '(must be the CURRENT owner)');
  console.log('  ⚠ After this tx the NEW owner controls the config; the current signer loses owner rights if it differs.\n');

  const sig = await solanaService.updateGlobalConfig(params, ownerKeypair);
  console.log('✅ Roles updated. Signature:', sig);
}

main().then(() => process.exit(0)).catch((e) => {
  console.error('\n❌ Role handover failed:', (e && e.message) ? e.message : e);
  process.exit(1);
});
