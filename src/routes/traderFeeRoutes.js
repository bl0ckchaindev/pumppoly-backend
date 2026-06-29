const express = require('express');
const ethers = require('ethers');
const router = express.Router();
const supabaseService = require('../services/supabaseService');
const { getEvmChainSlug, isSolanaChain, isEvmCompatibleChain, CHAIN_ID_TO_SLUG } = require('../lib/chainUtils');
const solanaService = require('../services/solanaService');
const { rewardClaimMessage, verifySolanaSignature } = require('../lib/solanaAuth');

// chain slug -> numeric chainId, for binding reward vouchers to the right chain.
const SLUG_TO_CHAIN_ID = Object.fromEntries(
    Object.entries(CHAIN_ID_TO_SLUG).map(([id, slug]) => [slug, Number(id)])
);

// Maximum reward percentage per trader (2% of total rewards pool)
// Must match the value in rewardDistributionService.js
const MAX_REWARD_PERCENTAGE = 0.02;

/**
 * Validate Solana wallet address (base58, 32-44 chars)
 */
function isValidSolanaAddress(wallet) {
    if (!wallet || typeof wallet !== 'string') return false;
    const trimmed = wallet.trim();
    if (trimmed.length < 32 || trimmed.length > 44) return false;
    if (trimmed.startsWith('0x')) return false;
    return true;
}

/**
 * Validate EVM wallet address (0x + 40 hex chars)
 */
function isValidEvmAddress(wallet) {
    if (!wallet || typeof wallet !== 'string') return false;
    const trimmed = wallet.trim().toLowerCase();
    return /^0x[a-f0-9]{40}$/.test(trimmed);
}

/**
 * Detect chain from wallet address
 */
function detectChain(wallet) {
    if (!wallet) return null;
    const trimmed = wallet.trim();
    if (trimmed.startsWith('0x') && trimmed.length === 42) return getEvmChainSlug();
    if (trimmed.length >= 32 && trimmed.length <= 44 && !trimmed.startsWith('0x')) return 'solana';
    return null;
}

/**
 * GET /reward-voucher?wallet=...&chain=base|sepolia|...
 * Returns a signed voucher the user submits to the RewardClaim contract to withdraw rewards
 * (user pays the gas). The voucher carries the wallet's ALL-TIME cumulative reward and a platform
 * signature over keccak256(claimContract, chainId, wallet, cumulative); the contract pays the
 * unclaimed delta. EVM-only for now (Solana voucher claims are Phase 2b).
 */
router.get('/reward-voucher', async (req, res) => {
    try {
        const wallet = (req.query.wallet || req.query.walletAddress || '').trim();
        let chain = (req.query.chain || '').toLowerCase() || detectChain(wallet);
        if (!wallet || !chain) {
            return res.status(400).json({ error: 'wallet and chain are required' });
        }
        if (!isEvmCompatibleChain(chain)) {
            return res.status(400).json({ error: 'Voucher claims are EVM-only for now' });
        }
        if (!isValidEvmAddress(wallet)) {
            return res.status(400).json({ error: 'Invalid EVM wallet address' });
        }

        const claimContract = process.env.REWARD_CLAIM_ADDRESS;
        const signerKey = process.env.REWARD_SIGNER_PRIVATE_KEY;
        if (!claimContract || !signerKey) {
            return res.status(503).json({ error: 'Reward claim not configured (REWARD_CLAIM_ADDRESS / REWARD_SIGNER_PRIVATE_KEY)' });
        }
        const chainId = SLUG_TO_CHAIN_ID[chain];
        if (!chainId) {
            return res.status(400).json({ error: `No chainId mapping for chain '${chain}'` });
        }

        const normalizedWallet = wallet.toLowerCase();
        const cumulativeAmount = await supabaseService.getCumulativeRewardFeeByWallet(normalizedWallet, chain);

        // Must match RewardClaim: keccak256(abi.encodePacked(address(this), block.chainid, wallet, amount))
        // then EIP-191 personal_sign of that 32-byte digest.
        const digest = ethers.utils.solidityKeccak256(
            ['address', 'uint256', 'address', 'uint256'],
            [claimContract, chainId, normalizedWallet, cumulativeAmount]
        );
        const signer = new ethers.Wallet(signerKey);
        const signature = await signer.signMessage(ethers.utils.arrayify(digest));

        return res.json({
            chain,
            chainId,
            wallet: normalizedWallet,
            claimContract,
            cumulativeAmount,                                       // wei, all-time
            cumulativeFormatted: ethers.utils.formatEther(cumulativeAmount),
            signature,
            signer: signer.address,
        });
    } catch (err) {
        console.error('GET /reward-voucher error:', err.message);
        return res.status(500).json({ error: err.message || 'Failed to build reward voucher' });
    }
});

/**
 * GET /trader-fee-claimable?wallet=...&chain=solana|evm
 * Returns estimated trader reward for a wallet based on distribution formula.
 * Reward = (rewardRatio * total_platform_fees) * (wallet_trader_fee / total_trader_fees)
 * Chain is auto-detected if not provided.
 */
router.get('/trader-fee-claimable', async (req, res) => {
    try {
        const wallet = (req.query.wallet || req.query.walletAddress || '').trim();
        if (!wallet) {
            return res.status(400).json({ error: 'wallet or walletAddress query is required' });
        }
        
        // Detect or validate chain
        let chain = (req.query.chain || '').toLowerCase();
        if (!chain) {
            chain = detectChain(wallet);
        }
        
        if (isSolanaChain(chain) && !isValidSolanaAddress(wallet)) {
            return res.status(400).json({ error: 'Invalid Solana wallet address' });
        }
        if (isEvmCompatibleChain(chain) && !isValidEvmAddress(wallet)) {
            return res.status(400).json({ error: 'Invalid EVM wallet address' });
        }
        if (!chain) {
            return res.status(400).json({ error: 'Unable to detect chain from wallet address. Please provide chain parameter (e.g. solana, base, polygon)' });
        }
        
        // Normalize wallet address
        const normalizedWallet = isEvmCompatibleChain(chain) ? wallet.toLowerCase() : wallet;
        
        // Get wallet's trader fees for this chain (trader_fees is one table; chain filter at DB)
        const chainRows = await supabaseService.getUnclaimedTraderFeesByWallet(normalizedWallet, chain);
        const walletTraderFeeAmount = chainRows.reduce((sum, r) => sum + BigInt(String(r.feeAmount || '0')), 0n);
        
        if (walletTraderFeeAmount <= 0n) {
            return res.json({
                walletAddress: normalizedWallet,
                chain,
                claimableAmount: '0',
                claimableFormatted: isEvmCompatibleChain(chain) ? '0.000000000000000000' : '0.000000000',
                isCapped: false,
                maxRewardPercentage: MAX_REWARD_PERCENTAGE,
                count: 0
            });
        }
        
        // Get total trader fees and platform fees for reward calculation
        const agg = await supabaseService.getTraderFeeAggregatesForReward(chain);
        const totalTraderFeeAmount = BigInt(agg.totalFeeLamports);
        
        const platformFeeAgg = await supabaseService.getTotalPlatformFeeAggregatesForReward(chain);
        const totalPlatformFeeAmount = BigInt(platformFeeAgg.totalPlatformFeeLamports);
        
        // Get reward ratio from config
        const config = await supabaseService.getRewardDistributionConfig();
        const rewardRatio = config.rewardRatio || 0.5;
        
        // Calculate estimated reward using distribution formula
        // total_rewards_pool = rewardRatio * total_platform_fees
        // wallet_reward = total_rewards_pool * (wallet_trader_fee / total_trader_fees)
        // But capped at 2% of total rewards pool
        let estimatedRewardAmount = 0n;
        let isCapped = false;
        if (totalTraderFeeAmount > 0n && totalPlatformFeeAmount > 0n) {
            const totalRewardsPool = (totalPlatformFeeAmount * BigInt(Math.round(rewardRatio * 10000))) / 10000n;
            const calculatedReward = (totalRewardsPool * walletTraderFeeAmount) / totalTraderFeeAmount;
            
            // Apply 2% cap
            const maxRewardPerTrader = (totalRewardsPool * BigInt(Math.round(MAX_REWARD_PERCENTAGE * 10000))) / 10000n;
            if (calculatedReward > maxRewardPerTrader) {
                estimatedRewardAmount = maxRewardPerTrader;
                isCapped = true;
            } else {
                estimatedRewardAmount = calculatedReward;
            }
        }
        
        // Format based on chain (SOL = 9 decimals, ETH = 18 decimals)
        const decimals = isEvmCompatibleChain(chain) ? 18 : 9;
        const claimableFormatted = (Number(estimatedRewardAmount) / Math.pow(10, decimals)).toFixed(decimals);
        
        return res.json({
            walletAddress: normalizedWallet,
            chain,
            claimableAmount: estimatedRewardAmount.toString(),
            claimableFormatted,
            isCapped, // true if reward was capped at 2% of total rewards pool
            maxRewardPercentage: MAX_REWARD_PERCENTAGE,
            // Legacy fields for backward compatibility (Solana)
            claimableLamports: estimatedRewardAmount.toString(),
            claimableSol: isSolanaChain(chain) ? claimableFormatted : undefined,
            claimableEth: isEvmCompatibleChain(chain) ? claimableFormatted : undefined,
            count: chainRows.length
        });
    } catch (error) {
        console.error('Error getting claimable trader fee:', error.message);
        return res.status(500).json({ error: error.message || 'Failed to get claimable fee' });
    }
});

/**
 * GET /creator-fee-claimable?wallet=...&chain=solana|evm
 * Returns claimable creator fee for a wallet (sum of fee_amount from tokens where creator = wallet).
 * Note: Creators receive their accumulated fees directly (no distribution formula applied).
 * Chain is auto-detected if not provided.
 */
router.get('/creator-fee-claimable', async (req, res) => {
    try {
        const wallet = (req.query.wallet || req.query.walletAddress || '').trim();
        if (!wallet) {
            return res.status(400).json({ error: 'wallet or walletAddress query is required' });
        }
        
        // Detect or validate chain
        let chain = (req.query.chain || '').toLowerCase();
        if (!chain) {
            chain = detectChain(wallet);
        }
        
        if (isSolanaChain(chain) && !isValidSolanaAddress(wallet)) {
            return res.status(400).json({ error: 'Invalid Solana wallet address' });
        }
        if (isEvmCompatibleChain(chain) && !isValidEvmAddress(wallet)) {
            return res.status(400).json({ error: 'Invalid EVM wallet address' });
        }
        if (!chain) {
            return res.status(400).json({ error: 'Unable to detect chain from wallet address. Please provide chain parameter (e.g. solana, base, polygon)' });
        }
        
        // Normalize wallet address
        const normalizedWallet = isEvmCompatibleChain(chain) ? wallet.toLowerCase() : wallet;
        
        const tokens = await supabaseService.getTokensByCreatorWithFees(normalizedWallet, chain);
        const totalAmount = tokens.reduce((sum, t) => sum + BigInt(String(t.feeAmount || '0')), 0n);
        
        // Format based on chain (SOL = 9 decimals, ETH = 18 decimals)
        const decimals = isEvmCompatibleChain(chain) ? 18 : 9;
        const claimableFormatted = (Number(totalAmount) / Math.pow(10, decimals)).toFixed(decimals);
        
        return res.json({
            walletAddress: normalizedWallet,
            chain,
            claimableAmount: totalAmount.toString(),
            claimableFormatted,
            // Legacy fields for backward compatibility (Solana)
            claimableLamports: totalAmount.toString(),
            claimableSol: isSolanaChain(chain) ? claimableFormatted : undefined,
            claimableEth: isEvmCompatibleChain(chain) ? claimableFormatted : undefined,
            tokenCount: tokens.length
        });
    } catch (error) {
        console.error('Error getting claimable creator fee:', error.message);
        return res.status(500).json({ error: error.message || 'Failed to get claimable fee' });
    }
});

// NOTE: POST /claim-trader-fee (legacy treasury-paid claim, platform paid the gas) was removed.
// Claims are user-paid: EVM via the RewardClaim voucher (GET /reward-voucher → on-chain claim),
// Solana via /claim-trader-fee/solana/build + /claim-trader-fee/solana/confirm below.

// ── Solana user-paid claim (treasury co-signs, user pays gas) ────────────────────────────────────
// Same amount basis as EVM: cumulative reward_fee minus already-claimed. Claimed + the in-flight
// lock live in the reward_claims table, so double-claim protection survives a backend restart.
const SOLANA_CLAIM_TTL_MS = 150 * 1000; // covers the blockhash validity window + margin
const SOLANA_CLAIM_AUTH_TTL_MS = 2 * 60 * 1000; // freshness window for the wallet-ownership proof

/**
 * Reconcile a wallet's in-flight claim against the chain so it can never be paid twice:
 *  - if the recorded signature confirmed → finalize (add to cumulative claimed, clear the lock)
 *  - else if the lock expired → it's dead (a Solana tx can't confirm past its blockhash) → clear it
 *  - else → still genuinely in-flight
 * Returns the latest reward_claims record.
 */
async function reconcileSolanaClaim(wallet) {
    let rec = await supabaseService.getRewardClaimRecord('solana', wallet);
    if (!rec || !rec.pending_amount) return rec;

    // If the user reported a signature, finalize only if it really is the treasury→wallet payout.
    if (rec.pending_signature) {
        const paid = await solanaService
            .verifyClaimPayout(rec.pending_signature, wallet, rec.pending_amount)
            .catch(() => false);
        if (paid) {
            await supabaseService.finalizeClaim('solana', wallet, rec.pending_amount);
            return await supabaseService.getRewardClaimRecord('solana', wallet);
        }
    }
    const expired = rec.pending_expires_at && new Date(rec.pending_expires_at).getTime() < Date.now();
    if (expired) {
        // Before releasing the lock, make sure the treasury didn't already pay this wallet during the
        // window. A user could submit the build tx but skip /confirm; clearing blindly would let them
        // rebuild and claim again. If a matching payout is found on-chain, finalize instead of clearing.
        const since = Math.floor((new Date(rec.pending_expires_at).getTime() - SOLANA_CLAIM_TTL_MS) / 1000);
        const paidSig = await solanaService
            .findTreasuryPayout(wallet, rec.pending_amount, since)
            .catch(() => null);
        if (paidSig) {
            await supabaseService.finalizeClaim('solana', wallet, rec.pending_amount);
        } else {
            await supabaseService.clearPendingClaim('solana', wallet);
        }
        return await supabaseService.getRewardClaimRecord('solana', wallet);
    }
    return rec; // in-flight, still within the window
}

function solanaClaimableLamports(cumulative, rec) {
    const claimed = BigInt((rec && rec.claimed_amount) || '0');
    const pendingActive =
        rec && rec.pending_amount && rec.pending_expires_at && new Date(rec.pending_expires_at).getTime() > Date.now()
            ? BigInt(rec.pending_amount)
            : 0n;
    const c = BigInt(cumulative) - claimed - pendingActive;
    return c > 0n ? c : 0n;
}

/**
 * GET /reward-claimable-solana?wallet=...
 * Read-only claimable (cumulative reward_fee − claimed − any in-flight lock), in lamports + SOL.
 */
router.get('/reward-claimable-solana', async (req, res) => {
    try {
        const wallet = (req.query.wallet || req.query.walletAddress || '').trim();
        if (!wallet || !isValidSolanaAddress(wallet)) {
            return res.status(400).json({ error: 'Invalid Solana wallet address' });
        }
        const rec = await reconcileSolanaClaim(wallet);
        const cumulative = await supabaseService.getCumulativeRewardFeeByWallet(wallet, 'solana');
        const claimable = solanaClaimableLamports(cumulative, rec);
        return res.json({
            wallet,
            chain: 'solana',
            claimableAmount: claimable.toString(),
            claimableFormatted: (Number(claimable) / 1e9).toFixed(9),
            decimals: 9,
        });
    } catch (err) {
        console.error('GET /reward-claimable-solana error:', err.message);
        return res.status(500).json({ error: err.message || 'Failed to get claimable' });
    }
});

/**
 * POST /claim-trader-fee/solana/build   Body: { wallet, signature, nonce, issuedAt }
 * Builds a treasury→user transfer with the USER as fee payer (treasury partial-signs). The user
 * co-signs and submits it, so they pay the network fee. Opens a DB-backed in-flight lock; the
 * cumulative claimed amount is advanced on /confirm once the tx lands on-chain.
 * Requires a wallet-ownership proof (ed25519 signature over a short-lived nonce'd message) so a
 * caller can't open / lock a claim for a wallet they don't control.
 */
router.post('/claim-trader-fee/solana/build', async (req, res) => {
    try {
        const wallet = (req.body?.wallet || req.body?.walletAddress || '').trim();
        if (!wallet || !isValidSolanaAddress(wallet)) {
            return res.status(400).json({ error: 'Invalid Solana wallet address' });
        }

        // Prove the requester controls `wallet` before opening a claim lock.
        const signature = (req.body?.signature || '').toString().trim();
        const nonce = (req.body?.nonce || '').toString().trim();
        const issuedAt = Number(req.body?.issuedAt);
        if (!signature || !nonce || !Number.isFinite(issuedAt)) {
            return res.status(401).json({ error: 'Wallet ownership proof required (signature, nonce, issuedAt)' });
        }
        const now = Date.now();
        if (issuedAt > now + 30 * 1000 || issuedAt < now - SOLANA_CLAIM_AUTH_TTL_MS) {
            return res.status(401).json({ error: 'Ownership proof expired — please retry the claim' });
        }
        if (!verifySolanaSignature(rewardClaimMessage(wallet, nonce, issuedAt), signature, wallet)) {
            return res.status(401).json({ error: 'Invalid wallet ownership signature' });
        }

        const rec = await reconcileSolanaClaim(wallet);
        if (rec && rec.pending_amount && rec.pending_expires_at && new Date(rec.pending_expires_at).getTime() > Date.now()) {
            return res.status(409).json({ error: 'A claim is already in progress — finish it or wait a moment, then retry.' });
        }

        const cumulative = await supabaseService.getCumulativeRewardFeeByWallet(wallet, 'solana');
        const claimed = BigInt((rec && rec.claimed_amount) || '0');
        const claimable = BigInt(cumulative) - claimed;
        if (claimable <= 0n) {
            return res.status(400).json({ error: 'No claimable rewards for this wallet' });
        }

        const built = await solanaService.buildTraderFeeClaimTx(wallet, claimable);
        await supabaseService.setPendingClaim(
            'solana',
            wallet,
            claimable.toString(),
            new Date(Date.now() + SOLANA_CLAIM_TTL_MS).toISOString()
        );

        return res.json({
            transaction: built.transaction, // base64, partially signed by treasury; user is fee payer
            amount: claimable.toString(),
            amountFormatted: (Number(claimable) / 1e9).toFixed(9),
            decimals: 9,
        });
    } catch (err) {
        console.error('POST /claim-trader-fee/solana/build error:', err.message);
        if (err.message && err.message.includes('TREASURY_PRIVATE_KEY')) {
            return res.status(503).json({ error: 'Reward claim not configured (treasury not set)' });
        }
        return res.status(500).json({ error: err.message || 'Failed to build claim transaction' });
    }
});

/**
 * POST /claim-trader-fee/solana/confirm   Body: { wallet, signature }
 * Records the signature, verifies it on-chain, then advances cumulative claimed (idempotent via
 * reconcile). If it isn't confirmed yet, returns { pending:true } and reconcile will finalize later.
 */
router.post('/claim-trader-fee/solana/confirm', async (req, res) => {
    try {
        const wallet = (req.body?.wallet || req.body?.walletAddress || '').trim();
        const signature = (req.body?.signature || '').trim();
        if (!wallet || !signature) {
            return res.status(400).json({ error: 'wallet and signature are required' });
        }
        const rec = await supabaseService.getRewardClaimRecord('solana', wallet);
        if (!rec || !rec.pending_amount) {
            return res.status(400).json({ error: 'No pending claim for this wallet (it may have expired — rebuild and retry)' });
        }
        // Record the signature first so reconcile can finalize even if the user disappears.
        await supabaseService.attachPendingSignature('solana', wallet, signature);

        // Finalize only when the signature is the actual treasury→wallet payout of the pending amount
        // (not just any confirmed tx). If it isn't confirmed/matching yet, reconcile finalizes it later.
        const paid = await solanaService.verifyClaimPayout(signature, wallet, rec.pending_amount);
        if (!paid) {
            return res.json({ success: false, pending: true, message: 'Claim submitted — confirming on-chain. Your balance will update shortly.' });
        }
        const amount = rec.pending_amount;
        await supabaseService.finalizeClaim('solana', wallet, amount);
        return res.json({ success: true, signature, amount });
    } catch (err) {
        console.error('POST /claim-trader-fee/solana/confirm error:', err.message);
        return res.status(500).json({ error: err.message || 'Failed to confirm claim' });
    }
});

module.exports = router;
