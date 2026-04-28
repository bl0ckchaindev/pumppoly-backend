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

        // Reward distribution: check every minute; run distribution when next_distribution_at is due
        const rewardDistributionService = require('./rewardDistributionService');
        const rewardDistributionJob = cron.schedule('* * * * *', async () => {
            try {
                await rewardDistributionService.checkAndRun();
            } catch (error) {
                console.error('[Cron] Reward distribution check error:', error.message);
            }
        }, {
            scheduled: false
        });
        this.jobs.push({ name: 'rewardDistribution', job: rewardDistributionJob });
        rewardDistributionJob.start();
        console.log('✓ Cron job started: Reward distribution (check every 1 min)');

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

