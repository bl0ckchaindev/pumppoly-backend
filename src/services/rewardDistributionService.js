/**
 * Trader and creator reward distribution service.
 * Supports both Solana and EVM chains.
 *
 * Trader rewards:
 *   total_rewards_pool = reward_ratio * total_platform_fees (sum of platform_fee in trader_fees)
 *   per-wallet reward = total_rewards_pool * (wallet_trader_fee / total_trader_fees)
 *   where wallet_trader_fee = sum of fee_amount for a specific wallet
 *   and total_trader_fees = sum of all fee_amount in trader_fees
 *   Native token (SOL/ETH) is sent from treasury to each trader; trader_fees is then cleaned and next_distribution_at advanced.
 *
 * Creator rewards (same round):
 *   tokens.fee_amount accumulates creator_fee from each TRADER_FEE/TraderFee event (per token).
 *   When the round finishes, each token's accumulated fee_amount is sent to that token's creator,
 *   then fee_amount is reset to 0. Same next_distribution_at as trader round.
 */

const supabaseService = require('./supabaseService');
const solanaService = require('./solanaService');
const evmService = require('./evmService');

const ROUND_MS_5MIN = 5 * 60 * 1000;

// Maximum reward percentage per trader (2% of total rewards pool)
// If a trader's calculated reward exceeds this cap, they receive only the capped amount
// and the excess is sent to the platform fee collector (treasury)
const MAX_REWARD_PERCENTAGE = 0.02;

const CYCLE_MS = {
    '1min': 60 * 1000,
    '5min': ROUND_MS_5MIN,
    '1hour': 60 * 60 * 1000,
    '1day': 24 * 60 * 60 * 1000,
    '1week': 7 * 24 * 60 * 60 * 1000
};

class RewardDistributionService {
    constructor() {
        this._checkIntervalId = null;
        this._checkIntervalMs = 60 * 1000; // check every minute whether it's time to distribute
    }

    /**
     * Get cycle duration in milliseconds.
     * @param {string} cycle - '1min' | '1hour' | '1day' | '1week'
     * @returns {number}
     */
    getCycleMs(cycle) {
        const ms = CYCLE_MS[cycle];
        if (ms == null) return CYCLE_MS['5min'];
        return ms;
    }

    /**
     * Run one round for a specific chain: when the round finishes, distribute rewards then initialize for the next round.
     * 1. Aggregate trader_fees (total trader fees and per wallet) and total platform fees for this round
     * 2. Compute total_rewards_pool = reward_ratio * total_platform_fees; per-wallet reward = total_rewards_pool * (wallet_trader_fee / total_trader_fees)
     * 3. Send native token (SOL/ETH) from treasury to each trader (above minimum threshold)
     * 4. Initialize trader_fees: delete rows where created_at < distribution time (this round's data)
     * 5. Set next_distribution_at = distribution_time + round length (next round end)
     * @param {string} chain - 'solana' | 'evm'
     */
    async runDistributionForChain(chain) {
        const distributionAt = new Date();
        const distributionAtIso = distributionAt.toISOString();
        const chainLabel = chain.toUpperCase();

        console.log(`[RewardDistribution:${chainLabel}] Starting distribution...`);

        let config;
        try {
            config = await supabaseService.getRewardDistributionConfig();
        } catch (err) {
            console.error(`[RewardDistribution:${chainLabel}] Failed to load config:`, err.message);
            return { ok: false, chain, error: err.message };
        }

        const { cycle, rewardRatio, minimumRewardLamports } = config;
        const minAmount = BigInt(minimumRewardLamports);
        const cycleMs = this.getCycleMs(cycle);

        let totalFeeAmount, byWallet, platformFeeAmount;
        try {
            const agg = await supabaseService.getTraderFeeAggregatesForReward(chain);
            totalFeeAmount = BigInt(agg.totalFeeLamports);
            byWallet = agg.byWallet;
            const platformFeeAgg = await supabaseService.getTotalPlatformFeeAggregatesForReward(chain);
            platformFeeAmount = BigInt(platformFeeAgg.totalPlatformFeeLamports);
        } catch (err) {
            console.error(`[RewardDistribution:${chainLabel}] Failed to get fee aggregates:`, err.message);
            return { ok: false, chain, error: err.message };
        }

        let creatorTokens = [];
        try {
            creatorTokens = await supabaseService.getTokensWithCreatorFeesToDistribute(chain);
        } catch (err) {
            console.error(`[RewardDistribution:${chainLabel}] Failed to get creator fee tokens:`, err.message);
        }

        const hasTraderPayouts = totalFeeAmount > 0n && byWallet.length > 0;
        const hasCreatorPayouts = creatorTokens.length > 0;

        if (!hasTraderPayouts && !hasCreatorPayouts) {
            console.log(`[RewardDistribution:${chainLabel}] No fees to distribute`);
            return { ok: true, chain, distributed: 0 };
        }

        let totalRewardsAmount = 0n;
        const payouts = [];
        let totalExcessAmount = 0n;

        if (hasTraderPayouts) {
            // Total rewards pool = rewardRatio * total platform fees
            totalRewardsAmount = (platformFeeAmount * BigInt(Math.round(rewardRatio * 10000))) / 10000n;
            
            // Max reward per trader = 2% of total rewards pool
            const maxRewardPerTrader = (totalRewardsAmount * BigInt(Math.round(MAX_REWARD_PERCENTAGE * 10000))) / 10000n;
            
            // Each trader's reward = total rewards pool * (trader's fee / total trader fees)
            // But capped at maxRewardPerTrader (2%)
            for (const { walletAddress, feeLamports } of byWallet) {
                const walletFee = BigInt(feeLamports);
                if (walletFee <= 0n) continue;
                
                let reward = (totalRewardsAmount * walletFee) / totalFeeAmount;
                
                // Apply 2% cap
                if (reward > maxRewardPerTrader) {
                    const excess = reward - maxRewardPerTrader;
                    totalExcessAmount += excess;
                    reward = maxRewardPerTrader;
                    console.log(`[RewardDistribution:${chainLabel}] Capped ${walletAddress}: calculated ${reward + excess}, capped to ${reward} (excess: ${excess})`);
                }
                
                if (reward < minAmount) continue;
                payouts.push({ walletAddress, amount: reward });
            }
            
            if (totalExcessAmount > 0n) {
                console.log(`[RewardDistribution:${chainLabel}] Total excess from caps: ${totalExcessAmount} (will be retained in treasury)`);
            }
        }

        // Chain-specific operations
        if (chain === 'solana') {
            // Solana: claim protocol fees from vault first
            if (payouts.length > 0) {
                try {
                    await solanaService.claimProtocolFee();
                } catch (err) {
                    console.error(`[RewardDistribution:${chainLabel}] Failed to claim protocol fee from vault:`, err.message);
                    // Continue - may still have funds in treasury
                }
                try {
                    await solanaService.ensureOwnerWsolAta();
                } catch (err) {
                    console.error(`[RewardDistribution:${chainLabel}] Failed to ensure owner WSOL ATA:`, err.message);
                }
            }
        } else if (chain === 'evm') {
            // EVM: ensure evmService is initialized
            try {
                await evmService.initialize();
            } catch (err) {
                console.error(`[RewardDistribution:${chainLabel}] Failed to initialize EVM service:`, err.message);
                return { ok: false, chain, error: `EVM service initialization failed: ${err.message}` };
            }
        }

        let successCount = 0;
        let failCount = 0;

        // Pay traders
        for (const { walletAddress, amount } of payouts) {
            try {
                if (chain === 'solana') {
                    await solanaService.payTraderFeeClaim(walletAddress, amount);
                } else if (chain === 'evm') {
                    await evmService.payTraderFeeClaim(walletAddress, amount);
                }
                successCount++;
            } catch (err) {
                console.error(`[RewardDistribution:${chainLabel}] Failed to send ${amount} to ${walletAddress}:`, err.message);
                failCount++;
            }
        }

        // Creator distribution: pay each token's creator, then reset token fee_amount
        let creatorSuccessCount = 0;
        let creatorFailCount = 0;
        for (const { tokenAddress, creator, feeAmount } of creatorTokens) {
            const amount = BigInt(feeAmount);
            if (amount <= 0n) continue;
            try {
                if (chain === 'solana') {
                    await solanaService.payTraderFeeClaim(creator, amount);
                } else if (chain === 'evm') {
                    await evmService.payTraderFeeClaim(creator, amount);
                }
                await supabaseService.resetTokenCreatorFee(tokenAddress, chain);
                creatorSuccessCount++;
            } catch (err) {
                console.error(`[RewardDistribution:${chainLabel}] Failed to send creator fee ${amount} to ${creator} (token ${tokenAddress}):`, err.message);
                creatorFailCount++;
            }
        }

        console.log(
            `[RewardDistribution:${chainLabel}] Complete: traders paid ${successCount}, failed ${failCount}; ` +
            `creators paid ${creatorSuccessCount}, failed ${creatorFailCount}`
        );

        return {
            ok: true,
            chain,
            totalFeesAmount: String(totalFeeAmount),
            totalRewardsAmount: String(totalRewardsAmount),
            paidCount: successCount,
            failCount,
            creatorPaidCount: creatorSuccessCount,
            creatorFailCount
        };
    }

    /**
     * Run one round: distribute rewards for both Solana and EVM chains.
     * 1. Run distribution for Solana
     * 2. Run distribution for EVM
     * 3. Clean up trader_fees and advance next_distribution_at
     */
    async runDistribution() {
        const distributionAt = new Date();
        const distributionAtIso = distributionAt.toISOString();

        let config;
        try {
            config = await supabaseService.getRewardDistributionConfig();
        } catch (err) {
            console.error('[RewardDistribution] Failed to load config:', err.message);
            return { ok: false, error: err.message };
        }

        const { cycle, rewardRatio } = config;
        const cycleMs = this.getCycleMs(cycle);

        // Run distribution for both chains
        const solanaResult = await this.runDistributionForChain('solana');
        const evmResult = await this.runDistributionForChain('evm');

        // Clean up trader_fees for both chains
        const deletedSolana = await supabaseService.deleteTraderFeesOlderThan(distributionAtIso, 'solana');
        const deletedEvm = await supabaseService.deleteTraderFeesOlderThan(distributionAtIso, 'evm');
        const totalDeleted = deletedSolana + deletedEvm;

        // Advance to next round
        const nextAt = new Date(distributionAt.getTime() + cycleMs);
        await supabaseService.updateRewardDistributionConfig({ nextDistributionAt: nextAt.toISOString() });

        // Log distribution run (combined stats)
        const totalFees = BigInt(solanaResult.totalFeesAmount || '0') + BigInt(evmResult.totalFeesAmount || '0');
        const totalRewards = BigInt(solanaResult.totalRewardsAmount || '0') + BigInt(evmResult.totalRewardsAmount || '0');
        const totalPaidCount = (solanaResult.paidCount || 0) + (evmResult.paidCount || 0);
        const totalFailCount = (solanaResult.failCount || 0) + (evmResult.failCount || 0);

        try {
            await supabaseService.insertRewardDistributionRun({
                distributionAt: distributionAtIso,
                cycle,
                rewardRatio,
                totalFeesLamports: String(totalFees),
                totalRewardsLamports: String(totalRewards),
                traderCount: totalPaidCount + totalFailCount,
                successCount: totalPaidCount,
                failCount: totalFailCount,
                chain: 'all'
            });
        } catch (err) {
            console.error('[RewardDistribution] Failed to log run:', err.message);
        }

        console.log(
            `[RewardDistribution] Round finished at ${distributionAtIso}: ` +
            `Solana (paid: ${solanaResult.paidCount || 0}, failed: ${solanaResult.failCount || 0}), ` +
            `EVM (paid: ${evmResult.paidCount || 0}, failed: ${evmResult.failCount || 0}); ` +
            `deleted ${totalDeleted} trader_fees rows; next at ${nextAt.toISOString()}`
        );

        return {
            ok: true,
            distributionAt: distributionAtIso,
            solana: solanaResult,
            evm: evmResult,
            deletedRows: totalDeleted,
            nextAt: nextAt.toISOString()
        };
    }

    /**
     * Get current config (for API).
     */
    async getConfig() {
        return supabaseService.getRewardDistributionConfig();
    }

    /**
     * Update config (cycle, rewardRatio, nextDistributionAt, minimumRewardLamports).
     */
    async updateConfig(updates) {
        await supabaseService.updateRewardDistributionConfig(updates);
    }

    /**
     * Check if the current round has finished (now >= next_distribution_at); if so, run distribution and start next round.
     */
    async checkAndRun() {
        let config;
        try {
            config = await supabaseService.getRewardDistributionConfig();
        } catch (err) {
            return;
        }
        const nextAt = new Date(config.nextDistributionAt);
        if (Date.now() >= nextAt.getTime()) {
            await this.runDistribution();
        }
    }

    /**
     * Start the scheduler: check every minute; when round end time is reached, distribute and start next round.
     */
    start() {
        if (this._checkIntervalId != null) {
            console.log('[RewardDistribution] Scheduler already running');
            return;
        }
        this._checkIntervalId = setInterval(() => {
            this.checkAndRun().catch((err) => {
                console.error('[RewardDistribution] Check error:', err.message);
            });
        }, this._checkIntervalMs);
        console.log('[RewardDistribution] Scheduler started (rounds auto-update every 5 min, check every 1 min)');
    }

    /**
     * Stop the scheduler.
     */
    stop() {
        if (this._checkIntervalId != null) {
            clearInterval(this._checkIntervalId);
            this._checkIntervalId = null;
            console.log('[RewardDistribution] Scheduler stopped');
        }
    }
}

module.exports = new RewardDistributionService();
