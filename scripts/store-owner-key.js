#!/usr/bin/env node
/**
 * One-time setup for the FULLY AUTOMATIC fee sweep: encrypt the Solana config owner's private key
 * (AES-256-GCM, secret from KEY_ENCRYPTION_SECRET in .env) and store it in the database. From then
 * on the backend cron signs claim_protocol_fee itself — no more weekly script runs.
 *
 * Safety rails:
 *   - refuses to store a key that does not match the CURRENT on-chain config owner
 *   - requires KEY_ENCRYPTION_SECRET (>= 32 chars; generate with: openssl rand -hex 32)
 *   - the plaintext key is passed inline and never written to disk or logged
 *
 * Usage (bash):
 *   read -s -p "Owner key: " SOLANA_OWNER_PRIVATE_KEY && export SOLANA_OWNER_PRIVATE_KEY && echo ""
 *   node scripts/store-owner-key.js
 *   unset SOLANA_OWNER_PRIVATE_KEY
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const keyVault = require('../src/lib/keyVault');
const solanaService = require('../src/services/solanaService');

const KEY_NAME = 'solana_config_owner';

async function main() {
  const plaintext = (process.env.SOLANA_OWNER_PRIVATE_KEY || '').trim();
  if (!plaintext) {
    throw new Error('SOLANA_OWNER_PRIVATE_KEY is not set (pass it inline; do not store it in .env)');
  }
  // Fails fast (before touching the chain) if KEY_ENCRYPTION_SECRET is missing/weak.
  const keypair = keyVault.parseSolanaKeypair(plaintext);

  await solanaService.initialize();
  const cfg = await solanaService.program.account.globalConfig.fetch(solanaService.getGlobalConfigPDA());
  if (!cfg.owner.equals(keypair.publicKey)) {
    throw new Error(
      `Provided key is for ${keypair.publicKey.toBase58()}, but the on-chain config owner is ` +
      `${cfg.owner.toBase58()} — refusing to store the wrong key`
    );
  }

  await keyVault.storeKey(KEY_NAME, plaintext);
  console.log('✅ Owner key stored encrypted as', `'${KEY_NAME}'`, `(wallet ${keypair.publicKey.toBase58()})`);
  console.log('The backend cron will now sweep the fee vault automatically (every 5 min, when it');
  console.log('holds enough to be worth collecting). No more manual sweep runs are needed.');
  console.log('');
  console.log('To revoke: delete the row from secure_keys, or rotate KEY_ENCRYPTION_SECRET —');
  console.log('either instantly disables automated signing.');
}

main().then(() => process.exit(0)).catch((e) => {
  console.error('\n❌ Store failed:', (e && e.message) ? e.message : e);
  process.exit(1);
});
