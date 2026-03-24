const express = require('express');
const router = express.Router();
const rewardDistributionService = require('../services/rewardDistributionService');

const VALID_CYCLES = ['1min', '5min', '1hour', '1day', '1week'];

/**
 * GET /reward-distribution/config
 * Returns current reward distribution config (cycle, rewardRatio, nextDistributionAt, minimumRewardLamports).
 */
router.get('/reward-distribution/config', async (req, res) => {
    try {
        const config = await rewardDistributionService.getConfig();
        return res.json(config);
    } catch (error) {
        console.error('Error getting reward distribution config:', error.message);
        return res.status(500).json({ error: error.message || 'Failed to get config' });
    }
});

/**
 * PATCH /reward-distribution/config
 * Body: { cycle?: '1min'|'5min'|'1hour'|'1day'|'1week', rewardRatio?: number, nextDistributionAt?: string (ISO), minimumRewardLamports?: number }
 * Updates reward distribution config. All fields optional.
 */
router.patch('/reward-distribution/config', async (req, res) => {
    try {
        const { cycle, rewardRatio, nextDistributionAt, minimumRewardLamports } = req.body || {};
        const updates = {};
        if (cycle != null) {
            if (!VALID_CYCLES.includes(cycle)) {
                return res.status(400).json({ error: `cycle must be one of: ${VALID_CYCLES.join(', ')}` });
            }
            updates.cycle = cycle;
        }
        if (rewardRatio != null) {
            const r = Number(rewardRatio);
            if (Number.isNaN(r) || r < 0 || r > 1) {
                return res.status(400).json({ error: 'rewardRatio must be between 0 and 1' });
            }
            updates.rewardRatio = r;
        }
        if (nextDistributionAt != null) {
            const d = new Date(nextDistributionAt);
            if (Number.isNaN(d.getTime())) {
                return res.status(400).json({ error: 'nextDistributionAt must be a valid ISO date string' });
            }
            updates.nextDistributionAt = d.toISOString();
        }
        if (minimumRewardLamports != null) {
            const n = Number(minimumRewardLamports);
            if (Number.isNaN(n) || n < 0) {
                return res.status(400).json({ error: 'minimumRewardLamports must be a non-negative number' });
            }
            updates.minimumRewardLamports = Math.floor(n);
        }
        if (Object.keys(updates).length === 0) {
            return res.status(400).json({ error: 'No valid fields to update' });
        }
        await rewardDistributionService.updateConfig(updates);
        const config = await rewardDistributionService.getConfig();
        return res.json(config);
    } catch (error) {
        console.error('Error updating reward distribution config:', error.message);
        return res.status(500).json({ error: error.message || 'Failed to update config' });
    }
});

/**
 * POST /reward-distribution/run
 * Manually trigger one reward distribution run (for testing or admin).
 */
router.post('/reward-distribution/run', async (req, res) => {
    try {
        const result = await rewardDistributionService.runDistribution();
        return res.json(result);
    } catch (error) {
        console.error('Error running reward distribution:', error.message);
        if (error.message && error.message.includes('TREASURY_PRIVATE_KEY')) {
            return res.status(503).json({ error: 'Reward distribution is not configured (treasury not set)' });
        }
        return res.status(500).json({ error: error.message || 'Failed to run distribution' });
    }
});

module.exports = router;
