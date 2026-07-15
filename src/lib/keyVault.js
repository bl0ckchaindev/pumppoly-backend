/**
 * Encrypted key vault: stores private keys AES-256-GCM-encrypted in the `secure_keys` table so
 * the backend can use them for automated signing (e.g. the owner-gated fee-vault sweep).
 *
 * Security model — two secrets must BOTH leak before a stored key is exposed:
 *   1. the database row (ciphertext + iv + tag), reachable only with the service-role key
 *   2. KEY_ENCRYPTION_SECRET from .env, which never touches the database
 * A database dump alone is useless; a leaked .env alone is useless. A full server compromise
 * (both at once) does expose stored keys — the key's owner must accept that trade-off.
 *
 * Decrypted material is returned to the caller and never cached or logged here.
 */
const crypto = require('crypto');
const { Keypair } = require('@solana/web3.js');
const bs58 = require('bs58');

// Version tag lets us rotate the KDF/cipher later without breaking stored rows.
const SCHEME = 'v1:aes-256-gcm:scrypt';

function deriveKey(secret) {
    if (!secret || secret.length < 32) {
        throw new Error('KEY_ENCRYPTION_SECRET must be set and at least 32 characters (generate: openssl rand -hex 32)');
    }
    // Static salt is acceptable here: the secret itself is required to be high-entropy random,
    // not a human password, so there is no dictionary to defend against.
    return crypto.scryptSync(secret, 'pumppoly-key-vault-v1', 32);
}

function encrypt(plaintext, secret) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(secret), iv);
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return {
        scheme: SCHEME,
        ciphertext: ct.toString('base64'),
        iv: iv.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
    };
}

function decrypt({ ciphertext, iv, tag }, secret) {
    const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey(secret), Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64')), decipher.final()]).toString('utf8');
}

/** Parse a Solana secret key in either format (base58 string or JSON array of 64 numbers). */
function parseSolanaKeypair(str) {
    const s = (str || '').trim();
    try {
        const arr = JSON.parse(s);
        if (Array.isArray(arr)) return Keypair.fromSecretKey(Uint8Array.from(arr));
    } catch { /* not JSON — try base58 */ }
    return Keypair.fromSecretKey(bs58.decode(s));
}

/** Encrypt `plaintextKey` and upsert it under `name`. Returns nothing sensitive. */
async function storeKey(name, plaintextKey) {
    const supabaseService = require('../services/supabaseService');
    const enc = encrypt(plaintextKey, process.env.KEY_ENCRYPTION_SECRET);
    await supabaseService.upsertSecureKey(name, enc);
}

/**
 * Load and decrypt the key stored under `name`; null when absent or undecryptable
 * (missing/wrong KEY_ENCRYPTION_SECRET) — callers treat null as "feature not enabled".
 */
async function loadKey(name) {
    const supabaseService = require('../services/supabaseService');
    const row = await supabaseService.getSecureKey(name);
    if (!row) return null;
    try {
        return decrypt(row, process.env.KEY_ENCRYPTION_SECRET);
    } catch (e) {
        console.error(`keyVault: cannot decrypt '${name}' (wrong or missing KEY_ENCRYPTION_SECRET?)`);
        return null;
    }
}

/** Load the key under `name` as a Solana Keypair, or null. */
async function loadSolanaKeypair(name) {
    const plain = await loadKey(name);
    if (!plain) return null;
    try {
        return parseSolanaKeypair(plain);
    } catch {
        console.error(`keyVault: stored key '${name}' is not a valid Solana secret key`);
        return null;
    }
}

module.exports = { storeKey, loadKey, loadSolanaKeypair, parseSolanaKeypair, encrypt, decrypt, SCHEME };
