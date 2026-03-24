const supabaseService = require('./supabaseService');
const { getEventListener } = require('../eventListener');

class TokenService {
    /**
     * Create or update token and bonding curve data
     * @param {Object} tokenData - Token creation data
     * @returns {Promise<Object>} Created token and bonding curve
     */
    async createToken(tokenData) {
        try {
            const {
                tokenAddress,
                bondingCurveAddress,
                creator,
                name,
                symbol,
                description,
                website,
                twitter,
                telegram,
                discord,
                logoUrl,
                bannerUrl,
                totalSupply,
                decimals,
                transactionHash,
                blockNumber,
                timestamp,
                initialPrice,
                feeAmount,
                virtualEthLp,
                virtualTokenLp,
                realEthLp,
                realTokenLp,
                k,
                tokenStartPrice,
                volume
            } = tokenData;

            // Check if token already exists (with chain parameter for Solana)
            const chain = tokenData.chain || 'evm';
            let token = await supabaseService.getTokenByAddress(tokenAddress, chain);
            let bondingCurve = await supabaseService.getBondingCurveByAddress(bondingCurveAddress, chain);

            if (token && bondingCurve) {
                // If logo/banner provided (e.g. from frontend register after upload), update token metadata
                if ((logoUrl || bannerUrl) && (String(logoUrl || '').trim() || String(bannerUrl || '').trim())) {
                    token = await supabaseService.updateToken(tokenAddress, { logoUrl: logoUrl || token.logoUrl, bannerUrl: bannerUrl || token.bannerUrl }, chain);
                }
                return { token, bondingCurve, isNew: false };
            }

            // Create token
            if (!token) {
                token = await supabaseService.createToken({
                    tokenAddress,
                    bondingCurveAddress,
                    chain: tokenData.chain || 'evm',
                    creator,
                    name: String(name || ''),
                    symbol: String(symbol || ''),
                    description: String(description || ''),
                    website: String(website || ''),
                    twitter: String(twitter || ''),
                    telegram: String(telegram || ''),
                    discord: String(discord || ''),
                    logoUrl: String(logoUrl || ''),
                    bannerUrl: String(bannerUrl || ''),
                    totalSupply: String(totalSupply || '0'),
                    decimals: Number(decimals || 18),
                    transactionHash,
                    blockNumber,
                    timestamp,
                    initialPrice: String(initialPrice || '0'),
                    feeAmount: String(feeAmount || '0')
                });
            }

            // Create bonding curve if it doesn't exist
            const isNewBondingCurve = !bondingCurve;
            if (!bondingCurve) {
                bondingCurve = await supabaseService.createBondingCurve({
                    bondingCurveAddress,
                    tokenAddress,
                    chain: tokenData.chain || 'evm',
                    creator,
                    virtualEthLp: String(virtualEthLp || tokenData.virtualEthLp || '0'),
                    virtualTokenLp: String(virtualTokenLp || tokenData.virtualTokenLp || '0'),
                    realEthLp: String(realEthLp || tokenData.realEthLp || '0'),
                    realTokenLp: String(realTokenLp || tokenData.realTokenLp || '0'),
                    k: String(k || tokenData.k || '0'),
                    tokenStartPrice: String(tokenStartPrice || '0'),
                    currentPrice: String(tokenStartPrice || '0'),
                    volume: String(volume || '0'),
                    lpCreated: Boolean(tokenData.lpCreated || false),
                    startTimestamp: timestamp,
                    transactionHash,
                    blockNumber
                });
            }

            // Always ensure the bonding curve is being listened to (for new or existing)
            // This handles cases where the bonding curve exists but listener wasn't started
            // Only call for EVM - Solana has its own event listener
            if (bondingCurve && bondingCurve.status === 'active' && chain === 'evm') {
                await this.ensureBondingCurveIsListened(bondingCurveAddress.toLowerCase());
            }

            return { token, bondingCurve, isNew: !token || isNewBondingCurve };
        } catch (error) {
            console.error('Error creating token:', error);
            throw error;
        }
    }

    /**
     * Ensure a bonding curve is being listened to by the event listener
     * @param {string} bondingCurveAddress - Bonding curve address
     * @returns {Promise<void>}
     */
    async ensureBondingCurveIsListened(bondingCurveAddress) {
        try {
            const listener = getEventListener();
            
            // Check if already listening
            if (listener.bondingCurveListeners && listener.bondingCurveListeners.has(bondingCurveAddress.toLowerCase())) {
                return; // Already listening
            }

            // Initialize provider if needed
            if (!listener.provider) {
                await listener.initialize();
            }

            // Start listening to the bonding curve
            await listener.listenToBondingCurve(bondingCurveAddress.toLowerCase());
            console.log(`✓ Started listening to bonding curve: ${bondingCurveAddress}`);
        } catch (error) {
            console.error(`✗ Failed to start listening to bonding curve ${bondingCurveAddress}:`, error.message);
            // Don't throw - this is a background operation
        }
    }

    /**
     * Update bonding curve data (price, volume, etc.)
     * @param {string} bondingCurveAddress - Bonding curve address
     * @param {Object} updateData - Data to update
     * @returns {Promise<Object>} Updated bonding curve
     */
    async updateBondingCurve(bondingCurveAddress, updateData) {
        try {
            const bondingCurve = await supabaseService.updateBondingCurve(
                bondingCurveAddress,
                updateData
            );

            if (!bondingCurve) {
                throw new Error('Bonding curve not found');
            }

            return bondingCurve;
        } catch (error) {
            console.error('Error updating bonding curve:', error);
            throw error;
        }
    }

    /**
     * Get token by address
     * @param {string} tokenAddress - Token address
     * @returns {Promise<Object>} Token data
     */
    async getTokenByAddress(tokenAddress) {
        return await supabaseService.getTokenByAddress(tokenAddress);
    }

    /**
     * Get bonding curve by address
     * @param {string} bondingCurveAddress - Bonding curve address
     * @returns {Promise<Object>} Bonding curve data
     */
    async getBondingCurveByAddress(bondingCurveAddress) {
        return await supabaseService.getBondingCurveByAddress(bondingCurveAddress);
    }

    /**
     * Get all tokens with pagination
     * @param {Object} options - Query options
     * @returns {Promise<Object>} Tokens and pagination info
     */
    async getAllTokens(options = {}) {
        return await supabaseService.getAllTokens(options);
    }

    /**
     * Get all bonding curves with pagination
     * @param {Object} options - Query options
     * @returns {Promise<Object>} Bonding curves and pagination info
     */
    async getAllBondingCurves(options = {}) {
        return await supabaseService.getAllBondingCurves(options);
    }

    /**
     * Sync all active bonding curves with event listener
     * Ensures all active bonding curves in database are being listened to
     * @param {string} [chain] - Optional chain filter: 'evm' or 'solana'. If omitted, fetches all.
     * @returns {Promise<Object>} Sync result
     */
    async syncAllActiveBondingCurves(chain = null) {
        try {
            const activeBondingCurves = await supabaseService.getActiveBondingCurves(chain);

            const listener = getEventListener();
            let initialized = false;
            let started = 0;
            let alreadyListening = 0;
            let failed = 0;

            for (const bc of activeBondingCurves) {
                const address = bc.bondingCurveAddress?.toLowerCase();
                if (!address) continue;

                try {
                    // Check if already listening
                    if (listener.bondingCurveListeners && listener.bondingCurveListeners.has(address)) {
                        alreadyListening++;
                        continue;
                    }

                    // Initialize provider if needed
                    if (!listener.provider && !initialized) {
                        await listener.initialize();
                        initialized = true;
                    }

                    // Start listening
                    await listener.listenToBondingCurve(address);
                    started++;
                } catch (error) {
                    failed++;
                    console.error(`✗ Failed to sync bonding curve ${address}:`, error.message);
                }
            }

            return {
                total: activeBondingCurves.length,
                started,
                alreadyListening,
                failed
            };
        } catch (error) {
            // Check if it's a connection error
            if (error.message && error.message.includes('fetch failed')) {
                throw new Error('Supabase connection failed. Please check your network connection and Supabase credentials.');
            }
            console.error('Error syncing bonding curves:', error);
            throw error;
        }
    }
}

module.exports = new TokenService();
