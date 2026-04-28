/**
 * Chain slug helpers for the `tokens.chain` (and related) columns.
 * Examples: solana, base, polygon, bsc, eth, sepolia, evm (legacy umbrella for EVM).
 * Solana uses base58 addresses; all other slugs use 0x hex normalization.
 */

function isSolanaChain(chain) {
    return String(chain || '').toLowerCase() === 'solana';
}

function isEvmCompatibleChain(chain) {
    const s = String(chain || '').trim();
    return s.length > 0 && !isSolanaChain(chain);
}

/** Default slug for this deployment’s EVM listener / payouts (see EVM_CHAIN_SLUG in .env). */
function getEvmChainSlug() {
    return (process.env.EVM_CHAIN_SLUG || 'evm').toLowerCase();
}

/** Map numeric chainId from wallets / registration to a stable DB slug. */
const CHAIN_ID_TO_SLUG = Object.freeze({
    1: 'eth',
    11155111: 'sepolia',
    137: 'polygon',
    56: 'bsc',
    8453: 'base',
    84532: 'base-sepolia'
});

function chainIdToSlug(chainId) {
    const n = Number(chainId);
    if (Number.isFinite(n) && CHAIN_ID_TO_SLUG[n]) {
        return CHAIN_ID_TO_SLUG[n];
    }
    return getEvmChainSlug();
}

module.exports = {
    isSolanaChain,
    isEvmCompatibleChain,
    getEvmChainSlug,
    chainIdToSlug,
    CHAIN_ID_TO_SLUG
};
