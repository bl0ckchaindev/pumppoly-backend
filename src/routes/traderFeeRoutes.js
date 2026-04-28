const express = require('express');
const router = express.Router();
const supabaseService = require('../services/supabaseService');
const { getEvmChainSlug, isSolanaChain, isEvmCompatibleChain } = require('../lib/chainUtils');
const solanaService = require('../services/solanaService');
const evmService = require('../services/evmService');

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

/**
 * POST /claim-trader-fee
 * Body: { walletAddress: string, chain?: 'solana' | 'evm' }
 * Fetches unclaimed fees for the wallet, transfers native token from treasury to the wallet, marks fees as claimed.
 * Chain is auto-detected if not provided.
 * NOTE: Rewards are distributed automatically by the scheduler; this endpoint is for manual claiming if needed.
 */
router.post('/claim-trader-fee', async (req, res) => {
    try {
        const walletAddress = (req.body?.walletAddress || req.body?.wallet || '').trim();
        if (!walletAddress) {
            return res.status(400).json({ error: 'walletAddress is required in request body' });
        }
        
        // Detect or validate chain
        let chain = (req.body?.chain || '').toLowerCase();
        if (!chain) {
            chain = detectChain(walletAddress);
        }
        
        if (isSolanaChain(chain) && !isValidSolanaAddress(walletAddress)) {
            return res.status(400).json({ error: 'Invalid Solana wallet address' });
        }
        if (isEvmCompatibleChain(chain) && !isValidEvmAddress(walletAddress)) {
            return res.status(400).json({ error: 'Invalid EVM wallet address' });
        }
        if (!chain) {
            return res.status(400).json({ error: 'Unable to detect chain from wallet address. Please provide chain parameter (e.g. solana, base, polygon)' });
        }
        
        // Normalize wallet address
        const normalizedWallet = isEvmCompatibleChain(chain) ? walletAddress.toLowerCase() : walletAddress;

        const chainRows = await supabaseService.getUnclaimedTraderFeesByWallet(normalizedWallet, chain);
        const totalAmount = chainRows.reduce((sum, r) => sum + BigInt(String(r.feeAmount || '0')), 0n);

        if (totalAmount <= 0n) {
            return res.status(400).json({ error: 'No claimable fees for this wallet' });
        }

        // Pay based on chain
        let txHash;
        if (isSolanaChain(chain)) {
            txHash = await solanaService.payTraderFeeClaim(normalizedWallet, totalAmount);
        } else if (isEvmCompatibleChain(chain)) {
            txHash = await evmService.payTraderFeeClaim(normalizedWallet, totalAmount);
        } else {
            return res.status(400).json({ error: 'Invalid chain' });
        }

        const ids = chainRows.map(r => r.id);
        await supabaseService.markTraderFeesAsClaimed(ids);

        // Format based on chain (SOL = 9 decimals, ETH = 18 decimals)
        const decimals = isEvmCompatibleChain(chain) ? 18 : 9;
        const claimableFormatted = (Number(totalAmount) / Math.pow(10, decimals)).toFixed(decimals);
        
        return res.json({
            success: true,
            chain,
            transactionHash: txHash,
            transactionSignature: isSolanaChain(chain) ? txHash : undefined, // Legacy field
            amount: totalAmount.toString(),
            amountFormatted: claimableFormatted,
            // Legacy fields
            amountLamports: totalAmount.toString(),
            amountSol: isSolanaChain(chain) ? claimableFormatted : undefined,
            amountEth: isEvmCompatibleChain(chain) ? claimableFormatted : undefined,
            walletAddress: normalizedWallet
        });
    } catch (error) {
        console.error('Error claiming trader fee:', error.message);
        if (error.message && error.message.includes('TREASURY_PRIVATE_KEY')) {
            return res.status(503).json({ error: 'Fee claim is not configured (treasury not set)' });
        }
        if (error.message && error.message.includes('No claimable')) {
            return res.status(400).json({ error: error.message });
        }
        return res.status(500).json({ error: error.message || 'Failed to claim fee' });
    }
});

module.exports = router;
