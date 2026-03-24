const express = require('express');
const router = express.Router();

// Import upload routes, token routes, trader fee routes, reward distribution routes, config routes
const uploadRoutes = require('./uploadRoutes');
const tokenRoutes = require('./tokenRoutes');
const traderFeeRoutes = require('./traderFeeRoutes');
const rewardDistributionRoutes = require('./rewardDistributionRoutes');
const configRoutes = require('./configRoutes');

// Apply CORS headers to all routes
router.use((req, res, next) => {
    res.header("X-Frame-Options", "DENY");
    res.header("Access-Control-Allow-Origin", "*");
    res.header(
        "Access-Control-Allow-Headers",
        "Origin, X-Requested-With, Content-Type, Accept"
    );
    next();
});

// Mount route modules
router.use(uploadRoutes);
router.use(tokenRoutes);
router.use(traderFeeRoutes);
router.use(rewardDistributionRoutes);
router.use(configRoutes);

module.exports = router;
