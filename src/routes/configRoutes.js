const express = require('express');
const router = express.Router();
const solanaService = require('../services/solanaService');
const adminAuth = require('../middleware/adminAuth');

/**
 * POST /update-global-config
 * Body: {
 *   protocolFeeBps: number,
 *   creatorFeeBps: number,
 *   rewardFeeBps: number,
 *   creatorMigrateFeeBps: number,
 *   protocolMigrateFeeBps: number,
 *   realSolThreshold: string | number  // lamports (e.g. 65000000000 for 65 SOL)
 * }
 * Updates the Solana program global config (owner-only; uses SOLANA_TREASURY_PRIVATE_KEY).
 * Protected: requires the admin key (x-admin-key header / Bearer token = ADMIN_API_KEY).
 */
router.post('/update-global-config', adminAuth, async (req, res) => {
    try {
        const body = req.body || {};
        const protocolFeeBps = body.protocolFeeBps;
        const creatorFeeBps = body.creatorFeeBps;
        const rewardFeeBps = body.rewardFeeBps;
        const creatorMigrateFeeBps = body.creatorMigrateFeeBps;
        const protocolMigrateFeeBps = body.protocolMigrateFeeBps;
        const realSolThreshold = body.realSolThreshold;
        const feeRecipient = body.feeRecipient; // optional: treasury that receives protocol fees (base58)

        if (feeRecipient != null && (typeof feeRecipient !== 'string' || feeRecipient.trim() === '')) {
            return res.status(400).json({ error: 'feeRecipient must be a base58 wallet address' });
        }

        if (protocolFeeBps === undefined || protocolFeeBps === null) {
            return res.status(400).json({ error: 'protocolFeeBps is required' });
        }
        if (creatorFeeBps === undefined || creatorFeeBps === null) {
            return res.status(400).json({ error: 'creatorFeeBps is required' });
        }
        if (rewardFeeBps === undefined || rewardFeeBps === null) {
            return res.status(400).json({ error: 'rewardFeeBps is required' });
        }
        if (creatorMigrateFeeBps === undefined || creatorMigrateFeeBps === null) {
            return res.status(400).json({ error: 'creatorMigrateFeeBps is required' });
        }
        if (protocolMigrateFeeBps === undefined || protocolMigrateFeeBps === null) {
            return res.status(400).json({ error: 'protocolMigrateFeeBps is required' });
        }
        if (realSolThreshold === undefined || realSolThreshold === null) {
            return res.status(400).json({ error: 'realSolThreshold is required (lamports)' });
        }

        const protocolFeeBpsNum = Number(protocolFeeBps);
        const creatorFeeBpsNum = Number(creatorFeeBps);
        const rewardFeeBpsNum = Number(rewardFeeBps);
        const creatorMigrateFeeBpsNum = Number(creatorMigrateFeeBps);
        const protocolMigrateFeeBpsNum = Number(protocolMigrateFeeBps);
        if (!Number.isInteger(protocolFeeBpsNum) || protocolFeeBpsNum < 0 || protocolFeeBpsNum > 10000) {
            return res.status(400).json({ error: 'protocolFeeBps must be an integer 0-10000' });
        }
        if (!Number.isInteger(creatorFeeBpsNum) || creatorFeeBpsNum < 0 || creatorFeeBpsNum > 10000) {
            return res.status(400).json({ error: 'creatorFeeBps must be an integer 0-10000' });
        }
        if (!Number.isInteger(rewardFeeBpsNum) || rewardFeeBpsNum < 0 || rewardFeeBpsNum > 10000) {
            return res.status(400).json({ error: 'rewardFeeBps must be an integer 0-10000' });
        }
        if (!Number.isInteger(creatorMigrateFeeBpsNum) || creatorMigrateFeeBpsNum < 0 || creatorMigrateFeeBpsNum > 10000) {
            return res.status(400).json({ error: 'creatorMigrateFeeBps must be an integer 0-10000' });
        }
        if (!Number.isInteger(protocolMigrateFeeBpsNum) || protocolMigrateFeeBpsNum < 0 || protocolMigrateFeeBpsNum > 10000) {
            return res.status(400).json({ error: 'protocolMigrateFeeBps must be an integer 0-10000' });
        }
        const realSolThresholdVal = String(realSolThreshold).trim();
        if (realSolThresholdVal === '' || !/^\d+$/.test(realSolThresholdVal)) {
            return res.status(400).json({ error: 'realSolThreshold must be a non-negative integer (lamports)' });
        }

        const signature = await solanaService.updateGlobalConfig({
            protocolFeeBps: protocolFeeBpsNum,
            creatorFeeBps: creatorFeeBpsNum,
            rewardFeeBps: rewardFeeBpsNum,
            creatorMigrateFeeBps: creatorMigrateFeeBpsNum,
            protocolMigrateFeeBps: protocolMigrateFeeBpsNum,
            realSolThreshold: realSolThresholdVal,
            feeRecipient
        });

        return res.json({
            success: true,
            transactionSignature: signature,
            config: {
                protocolFeeBps: protocolFeeBpsNum,
                creatorFeeBps: creatorFeeBpsNum,
                rewardFeeBps: rewardFeeBpsNum,
                creatorMigrateFeeBps: creatorMigrateFeeBpsNum,
                protocolMigrateFeeBps: protocolMigrateFeeBpsNum,
                realSolThreshold: realSolThresholdVal
            }
        });
    } catch (error) {
        console.error('Error updating global config:', error.message);
        return res.status(500).json({
            error: error.message || 'Failed to update global config'
        });
    }
});

module.exports = router;
