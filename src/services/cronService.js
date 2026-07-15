const cron = require('node-cron');
const { httpRpcUrl } = require('../config');
const { getEvmChainSlug } = require('../lib/chainUtils');

class CronService {
    constructor() {
        this.jobs = [];
        this.isRunning = false;
    }

    /**
     * Start all cron jobs
     */
    start() {
        if (this.isRunning) {
            console.log('Cron service is already running');
            return;
        }

        // Catch-up is handled by eventListener.startPeriodicCatchUp() (every 5 min), which runs
        // in the same process and shares the same RPC/state. A separate cron catch-up here would
        // double RPC and DB load every 5 minutes and increase latency for real-time EVM event
        // fetching (poll gets throttled or delayed when catch-up runs). So we do not schedule
        // catchUpService.catchUpAllBondingCurves() in cron. Use catchUpService directly only for
        // one-off/admin catch-up if needed.
        if (httpRpcUrl) {
            console.log('○ Catch-up cron intentionally disabled; eventListener handles periodic catch-up');
        } else {
            console.log('○ HTTP_RPC_URL not set; eventListener catch-up uses configured RPC');
        }

        // Optional: Health check job every hour
        const healthCheckJob = cron.schedule('0 * * * *', async () => {
            try {
                const supabaseService = require('./supabaseService');
                const activeBondingCurvesEvm = await supabaseService.getActiveBondingCurves(getEvmChainSlug());
                const activeCount = activeBondingCurvesEvm.length;
                const { getEventListener } = require('../eventListener');
                const listener = getEventListener();
                const listeningCount = listener.bondingCurveListeners ? listener.bondingCurveListeners.size : 0;
                
                console.log(`[Cron] Health check - Active bonding curves (EVM): ${activeCount}, Listening: ${listeningCount}`);
                
                // If there's a mismatch, sync EVM bonding curves (Solana has its own listener)
                if (activeCount > listeningCount) {
                    console.log('[Cron] Mismatch detected, syncing EVM bonding curves...');
                    const tokenService = require('./tokenService');
                    await tokenService.syncAllActiveBondingCurves(getEvmChainSlug());
                }
                // If we have EVM listeners but provider is dead, force recycle
                else if (activeCount > 0 && listeningCount > 0 && !listener.isRecycling) {
                    try {
                        await listener.provider.getBlockNumber();
                    } catch (providerErr) {
                        console.warn('[Cron] EVM provider unhealthy, triggering recycle:', providerErr.message);
                        listener.forceRecycleEVM('health-check-provider-unhealthy').catch(() => {});
                    }
                }
            } catch (error) {
                console.error('[Cron] Error in health check job:', error);
            }
        }, {
            scheduled: false
        });

        this.jobs.push({ name: 'healthCheck', job: healthCheckJob });
        healthCheckJob.start();
        console.log('✓ Cron job started: Health check every hour');

        // Reward distribution is now CLAIM-ONLY: rewards accumulate per wallet in the DB and are
        // paid out only when the user presses Claim (user pays the claim gas via the on-chain claim
        // mechanism). The automatic push-distribution scheduler is intentionally disabled so the
        // platform never auto-pays rewards with its own gas. (Re-enable by restoring this cron.)
        console.log('ℹ Reward auto-distribution disabled — rewards are claim-only.');

        // Solana claim-treasury auto-funding: sweep accumulated trade fees from the program's fee
        // vault into the treasury wallet (native SOL) so user claims never depend on a manual
        // top-up. No-ops (with a logged reason) until the on-chain fee_recipient is the treasury.
        const treasurySweepJob = cron.schedule('*/5 * * * *', async () => {
            try {
                const solanaService = require('./solanaService');
                const result = await solanaService.sweepFeeVaultToTreasury();
                if (result.swept) {
                    console.log(`[Cron] Fee vault swept to treasury: ${result.lamports} lamports`);
                } else if (!/below threshold|no fees collected/.test(result.reason || '')) {
                    console.warn(`[Cron] Treasury sweep skipped: ${result.reason}`);
                }
            } catch (error) {
                console.error('[Cron] Treasury sweep error:', error.message);
            }
        }, { scheduled: false });
        this.jobs.push({ name: 'treasurySweep', job: treasurySweepJob });
        treasurySweepJob.start();
        console.log('✓ Cron job started: Solana fee-vault → treasury sweep (every 5 min)');

        // Holder indexer: refresh on-chain holder balances for active tokens every 2 minutes.
        const holderSyncJob = cron.schedule('*/2 * * * *', async () => {
            try {
                const holderService = require('./holderService');
                const supabaseService = require('./supabaseService');
                const evmChain = getEvmChainSlug();

                // EVM: incremental Transfer-log scan + balanceOf refresh per token.
                const evmTokens = await supabaseService.getActiveTokensForHolderSync(evmChain);
                for (const t of evmTokens) {
                    await holderService.syncEvmHolders(t.tokenAddress, t.bondingCurveAddress, t.chain, t.blockNumber);
                    await new Promise((r) => setTimeout(r, 150)); // be gentle on the RPC
                }

                // Solana: full token-account rebuild per mint.
                const solTokens = await supabaseService.getActiveTokensForHolderSync('solana');
                for (const t of solTokens) {
                    await holderService.syncSolanaHolders(t.tokenAddress, t.chain);
                    await new Promise((r) => setTimeout(r, 300));
                }
            } catch (error) {
                console.error('[Cron] Holder sync error:', error.message);
            }
        }, { scheduled: false });
        this.jobs.push({ name: 'holderSync', job: holderSyncJob });
        holderSyncJob.start();
        console.log('✓ Cron job started: Holder indexer (every 2 min)');

        this.isRunning = true;
        console.log('Cron service started successfully');
    }

    /**
     * Stop all cron jobs
     */
    stop() {
        this.jobs.forEach(({ name, job }) => {
            job.stop();
            console.log(`Stopped cron job: ${name}`);
        });
        this.jobs = [];
        this.isRunning = false;
        console.log('Cron service stopped');
    }

    /**
     * Get status of cron jobs
     */
    getStatus() {
        return {
            isRunning: this.isRunning,
            jobs: this.jobs.map(({ name, job }) => ({
                name,
                running: job.running || false
            }))
        };
    }
}

module.exports = new CronService();

