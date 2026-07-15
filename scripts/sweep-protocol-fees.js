#!/usr/bin/env node
/**
 * Client-run protocol fee sweep (the config OWNER's job).
 *
 * claim_protocol_fee is owner-gated on-chain, and the owner role belongs to the client's wallet —
 * so this script is run BY THE CLIENT with their owner key, not by the server. It moves the
 * accumulated trade fees (platform 0.35% + trader-reward 0.30% of volume) from the program's fee
 * vault to the config's fee_recipient (as WSOL), then prints the exact platform/reward split so
 * the trader-reward share can be funded into the claim treasury.
 *
 * If fee_recipient IS the claim treasury, there is nothing more to do by hand: the backend cron
 * unwraps the WSOL and forwards the platform share to SOLANA_PLATFORM_FEE_WALLET automatically.
 * If fee_recipient is the client's own wallet, send the printed reward share to the treasury so
 * user claims stay funded.
 *
 * Usage (PowerShell — key passed inline, never stored):
 *   $env:SOLANA_OWNER_PRIVATE_KEY = "<owner wallet private key (base58 or JSON array)>"
 *   node scripts/sweep-protocol-fees.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Keypair } = require('@solana/web3.js');
const { getAssociatedTokenAddressSync } = require('@solana/spl-token');
const bs58 = require('bs58');
const solanaService = require('../src/services/solanaService');

const NATIVE_MINT_STR = 'So11111111111111111111111111111111111111112';

function loadKeypair(str) {
  const s = (str || '').trim();
  if (!s) throw new Error('SOLANA_OWNER_PRIVATE_KEY is not set (pass it inline; do not store it in .env)');
  try {
    const arr = JSON.parse(s);
    if (Array.isArray(arr)) return Keypair.fromSecretKey(Uint8Array.from(arr));
  } catch { /* not JSON — try base58 */ }
  return Keypair.fromSecretKey(bs58.decode(s));
}

async function main() {
  const owner = loadKeypair(process.env.SOLANA_OWNER_PRIVATE_KEY);
  await solanaService.initialize();
  const { PublicKey } = require('@solana/web3.js');
  const NATIVE_MINT = new PublicKey(NATIVE_MINT_STR);

  const cfg = await solanaService.program.account.globalConfig.fetch(solanaService.getGlobalConfigPDA());
  if (!cfg.owner.equals(owner.publicKey)) {
    throw new Error(`Signer ${owner.publicKey.toBase58()} is not the config owner (${cfg.owner.toBase58()})`);
  }

  const vaultAta = getAssociatedTokenAddressSync(NATIVE_MINT, solanaService.getFeeAuthorityPDA(), true);
  let vaultLamports = 0n;
  try {
    const bal = await solanaService.connection.getTokenAccountBalance(vaultAta);
    vaultLamports = BigInt(bal.value.amount);
  } catch { /* vault ATA doesn't exist yet */ }

  const sol = (v) => (Number(v) / 1e9).toFixed(9);
  console.log('Fee vault balance   :', sol(vaultLamports), 'SOL (wrapped)');
  if (vaultLamports <= 0n) {
    console.log('Nothing to sweep.');
    return;
  }

  const protocolBps = BigInt(cfg.protocolFeeBps ?? 35);
  const rewardBps = BigInt(cfg.rewardFeeBps ?? 30);
  const platformShare = (vaultLamports * protocolBps) / (protocolBps + rewardBps);
  const rewardShare = vaultLamports - platformShare;
  const treasury = solanaService.treasuryKeypair ? solanaService.treasuryKeypair.publicKey.toBase58() : '(treasury key not configured)';
  const recipient = cfg.feeRecipient.toBase58();

  console.log('Sweeping to fee_recipient:', recipient, '…');
  const sig = await solanaService.claimProtocolFee(owner);
  console.log('✅ Swept. Signature :', sig);
  console.log('');
  console.log(`Split of the swept amount (protocol ${protocolBps} bps / reward ${rewardBps} bps):`);
  console.log('  Platform share    :', sol(platformShare), 'SOL — yours to keep');
  console.log('  Trader-reward share:', sol(rewardShare), 'SOL — fund the claim treasury with this');
  console.log('  Claim treasury    :', treasury);
  if (recipient === treasury) {
    console.log('');
    console.log('fee_recipient IS the claim treasury — no manual transfer needed; the backend will');
    console.log('unwrap it and forward the platform share to SOLANA_PLATFORM_FEE_WALLET automatically.');
  } else {
    console.log('');
    console.log(`ACTION: the swept WSOL is now in ${recipient}.`);
    console.log(`Unwrap it and send ${sol(rewardShare)} SOL to the claim treasury (${treasury})`);
    console.log('so user reward claims stay funded.');
  }
}

main().then(() => process.exit(0)).catch((e) => {
  console.error('\n❌ Sweep failed:', (e && e.message) ? e.message : e);
  process.exit(1);
});
