const nacl = require('tweetnacl');
const { PublicKey } = require('@solana/web3.js');

/**
 * Canonical message a wallet signs to prove ownership before opening a reward claim.
 * MUST match the frontend `signRewardClaimAuth` byte-for-byte.
 */
function rewardClaimMessage(wallet, nonce, issuedAt) {
    return `PumpPoly reward claim\nwallet: ${wallet}\nnonce: ${nonce}\nissuedAt: ${issuedAt}`;
}

/** Verify an ed25519 signature (base64) over `message` by the base58 `publicKey`. */
function verifySolanaSignature(message, signatureB64, publicKeyB58) {
    try {
        const msg = new Uint8Array(Buffer.from(message, 'utf8'));
        const sig = new Uint8Array(Buffer.from(signatureB64, 'base64'));
        const pub = new PublicKey(publicKeyB58).toBytes();
        return sig.length === 64 && nacl.sign.detached.verify(msg, sig, pub);
    } catch (_) {
        return false;
    }
}

module.exports = { rewardClaimMessage, verifySolanaSignature };
