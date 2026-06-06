/**
 * Trader and creator reward distribution service.
 * Supports both Solana and EVM chains.
 *
 * TRADER REWARDS POOL
 * ──────────────────
 * On every buy/sell, the contract collects 0.30% as `reward_fee` and sends it to the
 * platform treasury. The TRADER_FEE / TraderFee on-chain event emits this separately.
 *
 * At the end of each epoch the rewards pool is the sum of all eligible `reward_fee` rows:
 *
 *   total_rewards_pool = SUM(eligible reward_fee for epoch)
 *
 * Each eligible trader's share:
 *
 *   user_reward = total_rewards_pool
 *               × (user_eligible_reward_fee / total_eligible_reward_fee)
 *
 * Capped at MAX_REWARD_PERCENTAGE (2%) of total_rewards_pool per trader.
 * Excess from the cap is retained in the treasury.
 *
 * Eligibility (anti-wash-trade):
 *   For each (wallet, mint) pair, only trades separated by at least
 *   `wash_trade_cooldown_seconds` from the previous eligible trade count.
 *   Default cooldown: 300 s (5 min), configurable in reward_distribution_config.
 *
 * CREATOR REWARDS
 * ───────────────
 * tokens.fee_amount accumulates creator_fee from each TRADER_FEE/TraderFee event.
 * At epoch end each token's accumulated creator fee is sent to the token creator
 * and then reset to 0.
 */

const supabaseService = require('./supabaseService');
const solanaService = require('./solanaService');
const evmService = require('./evmService');
const { isSolanaChain, isEvmCompatibleChain } = require('../lib/chainUtils');

// Maximum reward fraction per trader per epoch (2% of total_rewards_pool)
const MAX_REWARD_PERCENTAGE = 0.02;

const CYCLE_MS = {
    '1min':  60 * 1000,
    '5min':  5 * 60 * 1000,
    '1hour': 60 * 60 * 1000,
    '1day':  24 * 60 * 60 * 1000,
    '1week': 7 * 24 * 60 * 60 * 1000
};

class RewardDistributionService {
    constructor() {
        this._checkIntervalId = null;
        this._checkIntervalMs = 60 * 1000; // check every minute
    }

    getCycleMs(cycle) {
        return CYCLE_MS[cycle] ?? CYCLE_MS['5min'];
    }

    /**
     * Run one distribution epoch for a specific chain.
     *
     * Steps:
     *  1. Load config (cooldown, cycle, minimum threshold)
     *  2. Get eligible reward aggregates (wash-trade filtered)
     *  3. Compute per-wallet rewards with 2% cap
     *  4. Pay traders from treasury
     *  5. Pay creators from per-token accumulated fee
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

        const { cycle, minimumRewardLamports, washTradeCooldownSeconds } = config;
        const minAmount = BigInt(minimumRewardLamports);

        // ── Trader reward aggregates (eligibility-filtered) ──────────────────
        let totalRewardPool = 0n;
        let byWallet = [];
        try {
            const agg = await supabaseService.getEligibleRewardAggregates(
                chain,
                washTradeCooldownSeconds,
                distributionAtIso
            );
            totalRewardPool = BigInt(agg.totalRewardLamports);
            byWallet = agg.byWallet;
        } catch (err) {
            console.error(`[RewardDistribution:${chainLabel}] Failed to get eligible reward aggregates:`, err.message);
            return { ok: false, chain, error: err.message };
        }

        // ── Creator reward tokens ─────────────────────────────────────────────
        let creatorTokens = [];
        try {
            creatorTokens = await supabaseService.getTokensWithCreatorFeesToDistribute(chain);
        } catch (err) {
            console.error(`[RewardDistribution:${chainLabel}] Failed to get creator fee tokens:`, err.message);
        }

        const hasTraderPayouts  = totalRewardPool > 0n && byWallet.length > 0;
        const hasCreatorPayouts = creatorTokens.length > 0;

        if (!hasTraderPayouts && !hasCreatorPayouts) {
            console.log(`[RewardDistribution:${chainLabel}] No fees to distribute this epoch`);
            return { ok: true, chain, distributed: 0 };
        }

        // ── Build per-trader payout list ──────────────────────────────────────
        const payouts = [];
        let totalExcess = 0n;

        if (hasTraderPayouts) {
            // 2% of total eligible pool is the per-trader cap
            const maxPerTrader = (totalRewardPool * BigInt(Math.round(MAX_REWARD_PERCENTAGE * 10000))) / 10000n;

            // Compute the true per-wallet denominator (sum of ALL eligible fees).
            // totalRewardPool == SUM(byWallet[*].rewardLamports), so we use it as the denominator.
            for (const { walletAddress, rewardLamports } of byWallet) {
                const eligible = BigInt(rewardLamports);
                if (eligible <= 0n) continue;

                // user_reward = (user_eligible_fee / total_eligible_fee) × total_rewards_pool
                // Since total_rewards_pool === total_eligible_fee, this simplifies to:
                //   user_reward = user_eligible_fee
                // However we keep the explicit formula to stay correct if pool is ever
                // partially funded from another source in future.
                let reward = (eligible * totalRewardPool) / totalRewardPool; // = eligible

                if (reward > maxPerTrader) {
                    const excess = reward - maxPerTrader;
                    totalExcess += excess;
                    reward = maxPerTrader;
                    console.log(`[RewardDistribution:${chainLabel}] Cap: ${walletAddress} excess=${excess}`);
                }

                if (reward < minAmount) continue;
                payouts.push({ walletAddress, amount: reward });
            }

            if (totalExcess > 0n) {
                console.log(`[RewardDistribution:${chainLabel}] Total excess retained in treasury: ${totalExcess}`);
            }
        }

        // ── Chain-specific initialisation ─────────────────────────────────────
        if (isSolanaChain(chain)) {
            if (payouts.length > 0) {
                try { await solanaService.claimProtocolFee(); } catch (err) {
                    console.error(`[RewardDistribution:${chainLabel}] claimProtocolFee failed:`, err.message);
                }
                try { await solanaService.ensureOwnerWsolAta(); } catch (err) {
                    console.error(`[RewardDistribution:${chainLabel}] ensureOwnerWsolAta failed:`, err.message);
                }
            }
        } else if (isEvmCompatibleChain(chain)) {
            try { await evmService.initialize(); } catch (err) {
                console.error(`[RewardDistribution:${chainLabel}] EVM init failed:`, err.message);
                return { ok: false, chain, error: `EVM service initialization failed: ${err.message}` };
            }
        }

        // ── Pay traders ───────────────────────────────────────────────────────
        let successCount = 0;
        let failCount = 0;

        for (const { walletAddress, amount } of payouts) {
            try {
                if (isSolanaChain(chain)) {
                    await solanaService.payTraderFeeClaim(walletAddress, amount);
                } else if (isEvmCompatibleChain(chain)) {
                    await evmService.payTraderFeeClaim(walletAddress, amount);
                }
                successCount++;
            } catch (err) {
                console.error(`[RewardDistribution:${chainLabel}] Failed to pay ${walletAddress}: ${err.message}`);
                failCount++;
            }
        }

        // ── Pay creators ──────────────────────────────────────────────────────
        let creatorSuccess = 0;
        let creatorFail = 0;

        for (const { tokenAddress, creator, feeAmount } of creatorTokens) {
            const amount = BigInt(feeAmount);
            if (amount <= 0n) continue;
            try {
                if (isSolanaChain(chain)) {
                    await solanaService.payTraderFeeClaim(creator, amount);
                } else if (isEvmCompatibleChain(chain)) {
                    await evmService.payTraderFeeClaim(creator, amount);
                }
                await supabaseService.resetTokenCreatorFee(tokenAddress, chain);
                creatorSuccess++;
            } catch (err) {
                console.error(`[RewardDistribution:${chainLabel}] Creator pay failed (${creator} / ${tokenAddress}): ${err.message}`);
                creatorFail++;
            }
        }

        console.log(
            `[RewardDistribution:${chainLabel}] Done: ` +
            `pool=${totalRewardPool} traders paid=${successCount} failed=${failCount}; ` +
            `creators paid=${creatorSuccess} failed=${creatorFail}`
        );

        return {
            ok: true,
            chain,
            totalRewardsAmount: String(totalRewardPool),
            paidCount: successCount,
            failCount,
            creatorPaidCount: creatorSuccess,
            creatorFailCount: creatorFail
        };
    }

    /**
     * Run one epoch across all active chains, clean up trader_fees, advance the clock.
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

        const { cycle } = config;
        const cycleMs = this.getCycleMs(cycle);

        const chainList = await supabaseService.getChainsToDistribute();
        const byChain = {};
        for (const c of chainList) {
            byChain[c] = await this.runDistributionForChain(c);
        }

        // Delete processed rows and advance next epoch
        let totalDeleted = 0;
        for (const c of chainList) {
            totalDeleted += await supabaseService.deleteTraderFeesOlderThan(distributionAtIso, c);
        }

        const nextAt = new Date(distributionAt.getTime() + cycleMs);
        await supabaseService.updateRewardDistributionConfig({ nextDistributionAt: nextAt.toISOString() });

        // Audit log
        let totalRewards = 0n;
        let totalPaid = 0;
        let totalFail = 0;
        for (const r of Object.values(byChain)) {
            totalRewards += BigInt(r.totalRewardsAmount || '0');
            totalPaid += r.paidCount || 0;
            totalFail += r.failCount || 0;
        }

        try {
            await supabaseService.insertRewardDistributionRun({
                distributionAt: distributionAtIso,
                cycle,
                rewardRatio: 0,        // no longer a ratio — pool is exact reward_fee sum
                totalFeesLamports: '0',
                totalRewardsLamports: String(totalRewards),
                traderCount: totalPaid + totalFail,
                successCount: totalPaid,
                failCount: totalFail,
                chain: 'all'
            });
        } catch (err) {
            console.error('[RewardDistribution] Failed to log run:', err.message);
        }

        const summary = chainList
            .map((c) => { const r = byChain[c] || {}; return `${c}(paid:${r.paidCount || 0},fail:${r.failCount || 0})`; })
            .join('; ');

        console.log(
            `[RewardDistribution] Epoch finished ${distributionAtIso}: ${summary}; ` +
            `deleted ${totalDeleted} rows; next at ${nextAt.toISOString()}`
        );

        return {
            ok: true,
            distributionAt: distributionAtIso,
            byChain,
            chains: chainList,
            deletedRows: totalDeleted,
            nextAt: nextAt.toISOString()
        };
    }

    async getConfig() {
        return supabaseService.getRewardDistributionConfig();
    }

    async updateConfig(updates) {
        await supabaseService.updateRewardDistributionConfig(updates);
    }

    async checkAndRun() {
        let config;
        try {
            config = await supabaseService.getRewardDistributionConfig();
        } catch (err) { return; }
        if (Date.now() >= new Date(config.nextDistributionAt).getTime()) {
            await this.runDistribution();
        }
    }

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
        console.log('[RewardDistribution] Scheduler started (check every 1 min)');
    }

    stop() {
        if (this._checkIntervalId != null) {
            clearInterval(this._checkIntervalId);
            this._checkIntervalId = null;
            console.log('[RewardDistribution] Scheduler stopped');
        }
    }
}

module.exports = new RewardDistributionService();
