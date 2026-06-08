const express = require('express');
const router = express.Router();

// Import upload routes, token routes, trader fee routes, reward distribution routes, config routes
const uploadRoutes = require('./uploadRoutes');
const tokenRoutes = require('./tokenRoutes');
const traderFeeRoutes = require('./traderFeeRoutes');
const rewardDistributionRoutes = require('./rewardDistributionRoutes');
const configRoutes = require('./configRoutes');

// Security header for all routes. CORS headers are handled centrally by the cors()
// middleware in index.js — do NOT set Access-Control-Allow-Origin: '*' here, it would
// override the per-origin value and break credentialed requests.
router.use((req, res, next) => {
    res.header("X-Frame-Options", "DENY");
    next();
});

// Mount route modules
router.use(uploadRoutes);
router.use(tokenRoutes);
router.use(traderFeeRoutes);
router.use(rewardDistributionRoutes);
router.use(configRoutes);

module.exports = router;
