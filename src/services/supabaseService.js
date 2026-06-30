const { supabase } = require('../config/supabase');
const { isSolanaChain, isEvmCompatibleChain, getEvmChainSlug } = require('../lib/chainUtils');

// Helper to detect if address is Solana (base58) or EVM (hex with 0x prefix)
const isSolanaAddress = (address) => {
    if (!address) return false;
    // EVM addresses start with 0x and are 42 chars; Solana addresses are base58 (32-44 chars, no 0x)
    return !String(address).startsWith('0x');
};

// Normalize address based on chain type (auto-detect if chain not provided)
const normalizeAddress = (address, chain = null) => {
    if (!address) return address;
    const addr = String(address);
    const issolana = isSolanaChain(chain) || (chain === null && isSolanaAddress(addr));
    return issolana ? addr : addr.toLowerCase();
};

class SupabaseService {
    // ============================================
    // TOKENS
    // ============================================
    async createToken(tokenData) {
        const chain = tokenData.chain || getEvmChainSlug();
        // Solana addresses are base58, don't lowercase them
        const normalizeAddress = (addr, chainType) => {
            return isSolanaChain(chainType) ? addr : addr.toLowerCase();
        };
        const insertData = {
            token_address: normalizeAddress(tokenData.tokenAddress, chain),
            bonding_curve_address: normalizeAddress(tokenData.bondingCurveAddress, chain),
            creator: normalizeAddress(tokenData.creator, chain),
                name: tokenData.name,
                symbol: tokenData.symbol,
                description: tokenData.description || '',
                website: tokenData.website || '',
                twitter: tokenData.twitter || '',
                telegram: tokenData.telegram || '',
                discord: tokenData.discord || '',
                logo_url: tokenData.logoUrl || '',
                banner_url: tokenData.bannerUrl || '',
                total_supply: tokenData.totalSupply || '0',
                decimals: tokenData.decimals || 18,
            transaction_hash: isSolanaChain(chain) ? String(tokenData.transactionHash || '') : String(tokenData.transactionHash || '').toLowerCase(),
                block_number: tokenData.blockNumber,
                timestamp: tokenData.timestamp,
                initial_price: tokenData.initialPrice || '0',
                fee_amount: tokenData.feeAmount || '0',
                status: 'active'
        };

        // Add chain column if migration has been run
        // If chain column doesn't exist, the insert will fail with a clear error
        if (chain) {
            insertData.chain = chain;
        }

        const { data, error } = await supabase
            .from('tokens')
            .insert(insertData)
            .select()
            .single();

        if (error) {
            // Provide helpful error message if chain column is missing
            if (error.message && (error.message.includes('chain') || error.message.includes('column') && error.message.includes('does not exist'))) {
                throw new Error(`Database schema error: ${error.message}. Please run the migration script: db_migration/supabase-schema.sql`);
            }
            throw error;
        }
        return this.transformToken(data);
    }

    async getTokenByAddress(tokenAddress, chain = null) {
        // Solana addresses are base58, don't lowercase them
        const normalizedAddress = isSolanaChain(chain) ? tokenAddress : tokenAddress.toLowerCase();
        let query = supabase
            .from('tokens')
            .select('*')
            .eq('token_address', normalizedAddress);
        
        if (chain) {
            query = query.eq('chain', chain);
        }
        
        const { data, error } = await query.single();

        if (error && error.code !== 'PGRST116') throw error;
        return data ? this.transformToken(data) : null;
    }

    async updateToken(tokenAddress, updateData, chain = getEvmChainSlug()) {
        const address = isSolanaChain(chain) ? String(tokenAddress || '') : String(tokenAddress || '').toLowerCase();
        const existing = await this.getTokenByAddress(tokenAddress, chain);
        if (!existing) return null; // nothing to update
        const hasValue = (v) => typeof v === 'string' && v.trim() !== '';

        const mappedData = {};
        // Write-once for media on BOTH networks: only ever fill logo/banner that isn't already stored.
        // Once set, it's immutable — this is the single chokepoint, so no caller can overwrite it.
        if (updateData.logoUrl !== undefined && !(existing && hasValue(existing.logoUrl))) {
            mappedData.logo_url = String(updateData.logoUrl);
        }
        if (updateData.bannerUrl !== undefined && !(existing && hasValue(existing.bannerUrl))) {
            mappedData.banner_url = String(updateData.bannerUrl);
        }
        if (Object.keys(mappedData).length === 0) return existing;

        let query = supabase.from('tokens').update(mappedData).eq('token_address', address);
        if (chain) query = query.eq('chain', chain);
        const { data, error } = await query.select().single();
        if (error) throw error;
        return data ? this.transformToken(data) : null;
    }

    async getAllTokens(options = {}) {
        const { page = 1, limit = 20, sortBy = 'timestamp', sortOrder = -1, creator, status } = options;
        
        let query = supabase.from('tokens').select('*', { count: 'exact' });

        if (creator) query = query.eq('creator', creator.toLowerCase());
        if (status) query = query.eq('status', status);

        const sortColumn = this.mapSortColumn(sortBy, 'token');
        query = query.order(sortColumn, { ascending: sortOrder === 1 });
        query = query.range((page - 1) * limit, page * limit - 1);

        const { data, error, count } = await query;

        if (error) throw error;

        return {
            tokens: data.map(t => this.transformToken(t)),
            pagination: {
                page,
                limit,
                total: count,
                pages: Math.ceil(count / limit)
            }
        };
    }

    // ============================================
    // BONDING CURVES
    // ============================================
    async createBondingCurve(curveData) {
        const chain = curveData.chain || getEvmChainSlug();
        // Solana addresses are base58, don't lowercase them
        const normalizeAddress = (addr) => isSolanaChain(chain) ? String(addr || '') : String(addr || '').toLowerCase();
        const bondingCurveAddr = normalizeAddress(curveData.bondingCurveAddress);
        const tokenAddr = normalizeAddress(curveData.tokenAddress);
        const creatorAddr = normalizeAddress(curveData.creator);
        const txHash = isSolanaChain(chain) ? String(curveData.transactionHash || '') : String(curveData.transactionHash || '').toLowerCase();

        // Validate addresses based on chain
        if (isEvmCompatibleChain(chain)) {
        if (!bondingCurveAddr.match(/^0x[a-f0-9]{40}$/)) {
            throw new Error('Invalid bonding curve address format');
        }
        if (!tokenAddr.match(/^0x[a-f0-9]{40}$/)) {
            throw new Error('Invalid token address format');
        }
        if (!creatorAddr.match(/^0x[a-f0-9]{40}$/)) {
            throw new Error('Invalid creator address format');
        }
        if (txHash && !txHash.match(/^0x[a-f0-9]{64}$/)) {
            throw new Error('Invalid transaction hash format');
            }
        } else if (isSolanaChain(chain)) {
            // Solana addresses are base58 encoded, typically 32-44 characters
            if (bondingCurveAddr.length < 32 || bondingCurveAddr.length > 44) {
                throw new Error('Invalid Solana bonding curve address format');
            }
            if (tokenAddr.length < 32 || tokenAddr.length > 44) {
                throw new Error('Invalid Solana token address format');
            }
            if (creatorAddr.length < 32 || creatorAddr.length > 44) {
                throw new Error('Invalid Solana creator address format');
            }
        }

        // Sanitize and validate input data
        const insertData = {
            bonding_curve_address: bondingCurveAddr,
            token_address: tokenAddr,
            creator: creatorAddr,
            virtual_eth_lp: String(curveData.virtualEthLp ?? '0'),
            virtual_token_lp: String(curveData.virtualTokenLp ?? '0'),
            real_eth_lp: String(curveData.realEthLp ?? '0'),
            real_token_lp: String(curveData.realTokenLp ?? '0'),
            k: String(curveData.k ?? '0'),
            token_start_price: String(curveData.tokenStartPrice || '0'),
            current_price: String(curveData.currentPrice || curveData.tokenStartPrice || '0'),
            volume: String(curveData.volume || '0'),
            lp_created: Boolean(curveData.lpCreated || false),
            start_timestamp: Number(curveData.startTimestamp || curveData.timestamp || Date.now()),
            transaction_hash: txHash || null,
            block_number: Number(curveData.blockNumber || 0),
            status: 'active'
        };

        if (curveData.liquidityLockDurationSeconds != null && curveData.liquidityLockDurationSeconds !== '') {
            insertData.liquidity_lock_duration_seconds = String(curveData.liquidityLockDurationSeconds);
        }
        if (curveData.liquidityUnlockTimestamp != null && curveData.liquidityUnlockTimestamp !== '') {
            insertData.liquidity_unlock_timestamp = Number(curveData.liquidityUnlockTimestamp);
        }
        if (curveData.lpUnlocked === true || curveData.lpUnlocked === false) {
            insertData.lp_unlocked = Boolean(curveData.lpUnlocked);
        }

        // Only add chain if migration has been run (column exists)
        // If column doesn't exist, insert will fail and we'll catch it
        if (chain) {
            insertData.chain = chain;
        }
        
        const { data, error } = await supabase
            .from('bonding_curves')
            .insert(insertData)
            .select()
            .single();

        if (error) {
            // Provide helpful error message if chain column is missing
            if (error.message && (error.message.includes('chain') || (error.message.includes('column') && error.message.includes('does not exist')))) {
                throw new Error(`Database schema error: ${error.message}. Please run the migration script: db_migration/supabase-schema.sql`);
            }
            throw error;
        }
        return this.transformBondingCurve(data);
    }

    async getBondingCurveByAddress(bondingCurveAddress, chain = null) {
        // Solana addresses are base58, don't lowercase them
        const normalizedAddress = isSolanaChain(chain) ? bondingCurveAddress : bondingCurveAddress.toLowerCase();
        let query = supabase
            .from('bonding_curves')
            .select('*')
            .eq('bonding_curve_address', normalizedAddress);
        
        // Only filter by chain if provided and column exists
        // If chain column doesn't exist, the query will work without it
        if (chain) {
            try {
                query = query.eq('chain', chain);
            } catch (e) {
                // Chain column doesn't exist, continue without it
                console.warn('⚠ Chain column not found, querying without chain filter');
            }
        }
        
        const { data, error } = await query.single();

        if (error && error.code !== 'PGRST116') {
            // If error is about chain column, try without chain filter
            if (error.message && error.message.includes('chain')) {
                console.warn('⚠ Chain column not found, retrying query without chain filter');
                const retryQuery = supabase
                    .from('bonding_curves')
                    .select('*')
                    .eq('bonding_curve_address', normalizedAddress);
                const { data: retryData, error: retryError } = await retryQuery.single();
                if (retryError && retryError.code !== 'PGRST116') throw retryError;
                return retryData ? this.transformBondingCurve(retryData) : null;
            }
            throw error;
        }
        return data ? this.transformBondingCurve(data) : null;
    }

    async getBondingCurveByTokenAddress(tokenAddress) {
        const { data, error } = await supabase
            .from('bonding_curves')
            .select('*')
            .eq('token_address', tokenAddress.toLowerCase())
            .single();

        if (error && error.code !== 'PGRST116') throw error;
        return data ? this.transformBondingCurve(data) : null;
    }

    async updateBondingCurve(bondingCurveAddress, updateData) {
        // Validate address and sanitize input
        const chain = updateData.chain || getEvmChainSlug();
        // Solana addresses are base58, don't lowercase them
        const address = isSolanaChain(chain) ? String(bondingCurveAddress || '') : String(bondingCurveAddress || '').toLowerCase();
        
        // Validate based on chain
        if (isEvmCompatibleChain(chain) && (!address || !address.match(/^0x[a-f0-9]{40}$/))) {
            throw new Error('Invalid EVM bonding curve address');
        } else if (isSolanaChain(chain) && (address.length < 32 || address.length > 44)) {
            throw new Error('Invalid Solana bonding curve address');
        }

        const mappedData = {};
        if (updateData.currentPrice !== undefined) mappedData.current_price = String(updateData.currentPrice);
        if (updateData.volume !== undefined) mappedData.volume = String(updateData.volume);
        if (updateData.virtualEthLp !== undefined) mappedData.virtual_eth_lp = String(updateData.virtualEthLp);
        if (updateData.virtualTokenLp !== undefined) mappedData.virtual_token_lp = String(updateData.virtualTokenLp);
        if (updateData.realEthLp !== undefined) mappedData.real_eth_lp = String(updateData.realEthLp);
        if (updateData.realTokenLp !== undefined) mappedData.real_token_lp = String(updateData.realTokenLp);
        if (updateData.k !== undefined) mappedData.k = String(updateData.k);
        if (updateData.totalTrades !== undefined) mappedData.total_trades = Number(updateData.totalTrades);
        if (updateData.totalBuyers !== undefined) mappedData.total_buyers = Number(updateData.totalBuyers);
        if (updateData.totalSellers !== undefined) mappedData.total_sellers = Number(updateData.totalSellers);
        if (updateData.lpCreated !== undefined) mappedData.lp_created = Boolean(updateData.lpCreated);
        if (updateData.liquidityTokenId !== undefined) mappedData.liquidity_token_id = updateData.liquidityTokenId;
        if (updateData.status !== undefined) mappedData.status = String(updateData.status);
        if (updateData.liquidityLockDurationSeconds !== undefined) {
            mappedData.liquidity_lock_duration_seconds = String(updateData.liquidityLockDurationSeconds);
        }
        if (updateData.liquidityUnlockTimestamp !== undefined) {
            mappedData.liquidity_unlock_timestamp = Number(updateData.liquidityUnlockTimestamp);
        }
        if (updateData.lpUnlocked !== undefined) mappedData.lp_unlocked = Boolean(updateData.lpUnlocked);

        let query = supabase
            .from('bonding_curves')
            .update(mappedData)
            .eq('bonding_curve_address', address);
        
        // Only filter by chain if provided and column exists
        // If chain column doesn't exist, the query will work without it
        if (chain) {
            try {
                query = query.eq('chain', chain);
            } catch (e) {
                // Chain column doesn't exist, continue without it
                console.warn('⚠ Chain column not found, updating without chain filter');
            }
        }
        
        const { data, error } = await query.select().single();
        
        if (error) {
            // If error is about chain column, try without chain filter
            if (error.message && error.message.includes('chain')) {
                console.warn('⚠ Chain column not found, retrying update without chain filter');
                const retryQuery = supabase
                    .from('bonding_curves')
                    .update(mappedData)
                    .eq('bonding_curve_address', address);
                const { data: retryData, error: retryError } = await retryQuery.select().single();
                if (retryError) {
                    // Provide helpful error message if chain column is missing
                    if (retryError.message && (retryError.message.includes('chain') || (retryError.message.includes('column') && retryError.message.includes('does not exist')))) {
                        throw new Error(`Database schema error: ${retryError.message}. Please run the migration script: db_migration/supabase-schema.sql`);
                    }
                    throw retryError;
                }
                return this.transformBondingCurve(retryData);
            }
            // Provide helpful error message if chain column is missing
            if (error.message && (error.message.includes('chain') || (error.message.includes('column') && error.message.includes('does not exist')))) {
                throw new Error(`Database schema error: ${error.message}. Please run the migration script: db_migration/supabase-schema.sql`);
            }
            throw error;
        }

        if (error) throw error;
        return this.transformBondingCurve(data);
    }

    async getAllBondingCurves(options = {}) {
        const { page = 1, limit = 20, sortBy = 'startTimestamp', sortOrder = -1, creator, status } = options;
        
        let query = supabase.from('bonding_curves').select('*', { count: 'exact' });

        if (creator) query = query.eq('creator', creator.toLowerCase());
        if (status) query = query.eq('status', status);

        const sortColumn = this.mapSortColumn(sortBy, 'bondingCurve');
        query = query.order(sortColumn, { ascending: sortOrder === 1 });
        query = query.range((page - 1) * limit, page * limit - 1);

        const { data, error, count } = await query;

        if (error) throw error;

        return {
            bondingCurves: data.map(bc => this.transformBondingCurve(bc)),
            pagination: {
                page,
                limit,
                total: count,
                pages: Math.ceil(count / limit)
            }
        };
    }

    async getActiveBondingCurves(chain = null) {
        // Try with chain column first
        let query = supabase
            .from('bonding_curves')
            .select('bonding_curve_address, chain')
            .eq('status', 'active');

        if (chain) {
            query = query.eq('chain', chain);
        }

        const { data, error } = await query;

        if (error) {
            // If error is about chain column not existing, retry without chain
            if (error.message && (error.message.includes('chain') || error.message.includes('does not exist'))) {
                console.warn('⚠ Chain column not found in database. Please run migration: db_migration/supabase-schema.sql');
                console.warn('⚠ Retrying query without chain column...');
                const retryQuery = supabase
                    .from('bonding_curves')
                    .select('bonding_curve_address')
                    .eq('status', 'active');
                const { data: retryData, error: retryError } = await retryQuery;
                if (retryError) {
                    throw new Error(`Database query failed: ${retryError.message}. Please run the migration script: db_migration/supabase-schema.sql`);
                }
                return retryData.map(bc => ({ 
                    bondingCurveAddress: bc.bonding_curve_address,
                    chain: getEvmChainSlug() // Default if chain column doesn't exist
                }));
            }
            throw error;
        }
        
        return data.map(bc => ({ 
            bondingCurveAddress: bc.bonding_curve_address,
            chain: bc.chain || getEvmChainSlug()
        }));
    }

    // ============================================
    // CHAT MESSAGES (Comments)
    // ============================================
    async addChatMessage(messageData) {
        const { data, error } = await supabase
            .from('chat_messages')
            .insert({
                token_address: messageData.tokenAddress.toLowerCase(),
                sender: messageData.sender.toLowerCase(),
                content: messageData.content,
                image_url: messageData.imageUrl || '',
                timestamp: messageData.timestamp
            })
            .select()
            .single();

        if (error) throw error;
        return this.transformChatMessage(data);
    }

    async getChatMessagesByToken(tokenAddress) {
        const { data, error } = await supabase
            .from('chat_messages')
            .select('*')
            .eq('token_address', tokenAddress.toLowerCase())
            .order('timestamp', { ascending: false });

        if (error) throw error;
        return data.map(m => this.transformChatMessage(m));
    }

    async checkChatMessageExists(timestamp) {
        const { data, error } = await supabase
            .from('chat_messages')
            .select('id')
            .eq('timestamp', timestamp)
            .single();

        if (error && error.code !== 'PGRST116') throw error;
        return !!data;
    }

    async getLatestChatsByToken() {
        const { data, error } = await supabase
            .from('chat_messages')
            .select('token_address, timestamp')
            .order('timestamp', { ascending: false });

        if (error) throw error;

        // Group by token and get latest
        const latestByToken = {};
        data.forEach(msg => {
            if (!latestByToken[msg.token_address]) {
                latestByToken[msg.token_address] = msg.timestamp;
            }
        });

        return Object.entries(latestByToken).map(([tokenAddress, timestamp]) => ({
            tokenAddress,
            timestamp
        }));
    }

    // ============================================
    // TOKEN PRICE DATA (Charts)
    // ============================================
    async addTokenPriceData(priceData) {
        const chain = priceData.chain || getEvmChainSlug();
        
        // Normalize addresses based on chain (Solana addresses are base58, don't lowercase)
        const normalizeAddress = (addr) => isSolanaChain(chain) ? String(addr || '') : String(addr || '').toLowerCase();
        const normalizeTxHash = (hash) => isSolanaChain(chain) ? String(hash || '') : String(hash || '').toLowerCase();
        
        // Validate transaction hash based on chain
        const txHash = normalizeTxHash(priceData.transactionHash);
        if (!txHash) {
            throw new Error('Missing transaction hash');
        }
        
        // EVM: 0x + 64 hex chars; Solana: base58 signature (typically 87-88 chars)
        if (isEvmCompatibleChain(chain) && !txHash.match(/^0x[a-f0-9]{64}$/)) {
            throw new Error('Invalid EVM transaction hash format');
        } else if (isSolanaChain(chain) && (txHash.length < 80 || txHash.length > 100)) {
            throw new Error('Invalid Solana transaction signature format');
        }

        // Check if already exists
        if (await this.checkPriceDataExists(txHash, chain)) {
            return null;
        }

        // Insert with duplicate error handling
        // First buy / initial trade: open_price may be 0 from contract or bonding curve; use close_price so chart shows correctly
        const closePriceStr = String(priceData.closePrice || '0');
        const rawOpen = priceData.openPrice != null ? String(priceData.openPrice).trim() : '';
        const openPriceStr = (rawOpen !== '' && rawOpen !== '0') ? rawOpen : closePriceStr;

        try {
            const insertData = {
                token_address: normalizeAddress(priceData.tokenAddress),
                timestamp: Number(priceData.timestamp || 0),
                open_price: openPriceStr,
                close_price: closePriceStr,
                amount: String(priceData.amount || '0'),
                trader: normalizeAddress(priceData.trader),
                is_buy: Boolean(priceData.isBuy || false),
                transaction_hash: txHash,
                block_number: Number(priceData.blockNumber || 0)
            };

            const { data, error } = await supabase
                .from('token_price_data')
                .insert(insertData)
                .select()
                .single();

            if (error) {
                // Handle duplicate key errors (race conditions)
                if (error.code === '23505' || error.code === 'PGRST204' ||
                    error.message?.includes('duplicate')) {
                    return null;
                }
                throw error;
            }

            // A genuinely new price point landed — recompute this token's 24h change.
            // Fire-and-forget so ingestion isn't blocked; covers every trade path (live + catch-up).
            if (data) {
                this.refreshPriceChange24h(priceData.tokenAddress, chain).catch(() => {});
            }

            return data ? this.transformPriceData(data) : null;
        } catch (error) {
            if (error.code === '23505' || error.code === 'PGRST204' || 
                error.message?.includes('duplicate')) {
                return null;
            }
            throw error;
        }
    }

    async getTokenPriceData(tokenAddress, limit = 1000, chain = null) {
        // Normalize address (auto-detects Solana vs EVM if chain not provided)
        const normalizedAddress = normalizeAddress(tokenAddress, chain);
        const { data, error } = await supabase
            .from('token_price_data')
            .select('*')
            .eq('token_address', normalizedAddress)
            .order('timestamp', { ascending: false })
            .limit(limit);

        if (error) throw error;
        return data.map(p => this.transformPriceData(p));
    }

    async getTokenPriceDataRange(tokenAddress, fromTimestamp, toTimestamp, chain = null) {
        // Normalize address (auto-detects Solana vs EVM if chain not provided)
        const normalizedAddress = normalizeAddress(tokenAddress, chain);
        const { data, error } = await supabase
            .from('token_price_data')
            .select('*')
            .eq('token_address', normalizedAddress)
            .gte('timestamp', fromTimestamp)
            .lte('timestamp', toTimestamp)
            .order('timestamp', { ascending: false });

        if (error) throw error;
        return data.map(p => this.transformPriceData(p));
    }

    /**
     * Compute a token's 24h price change (%) from token_price_data. Price is a ratio so the raw
     * scaled close_price values cancel out. Returns a number (2 decimals) or null if no data.
     * Mirrors the frontend: base = first point in the last 24h, else the earliest point.
     */
    async getPriceChange24h(tokenAddress, chain = null) {
        const addr = normalizeAddress(tokenAddress, chain);
        const cutoff = Math.floor(Date.now() / 1000) - 86400;

        const latestQ = await supabase
            .from('token_price_data')
            .select('close_price, timestamp')
            .eq('token_address', addr)
            .order('timestamp', { ascending: false })
            .limit(1);
        const latest = latestQ.data && latestQ.data[0];
        if (!latest) return null;

        let baseQ = await supabase
            .from('token_price_data')
            .select('close_price, timestamp')
            .eq('token_address', addr)
            .gte('timestamp', cutoff)
            .order('timestamp', { ascending: true })
            .limit(1);
        let base = baseQ.data && baseQ.data[0];
        if (!base) {
            const earliestQ = await supabase
                .from('token_price_data')
                .select('close_price, timestamp')
                .eq('token_address', addr)
                .order('timestamp', { ascending: true })
                .limit(1);
            base = earliestQ.data && earliestQ.data[0];
        }
        if (!base) return null;

        const l = Number(latest.close_price);
        const b = Number(base.close_price);
        if (!isFinite(l) || !isFinite(b) || b <= 0) return null;
        const change = Math.round(((l - b) / b) * 100 * 100) / 100;
        // Clamp to the price_changed_24h column's NUMERIC(10,2) range.
        return Math.max(-99999999.99, Math.min(99999999.99, change));
    }

    /** Persist a token's 24h price change (%) onto the tokens row. `value` may be null. */
    async setTokenPriceChange24h(tokenAddress, chain, value) {
        const address = isSolanaChain(chain) ? String(tokenAddress || '') : String(tokenAddress || '').toLowerCase();
        let query = supabase.from('tokens').update({ price_changed_24h: value }).eq('token_address', address);
        if (chain) query = query.eq('chain', chain);
        const { error } = await query;
        if (error) throw error;
    }

    /** Recompute and store a token's 24h price change. Call after each new trade. Never throws. */
    async refreshPriceChange24h(tokenAddress, chain) {
        try {
            const change = await this.getPriceChange24h(tokenAddress, chain);
            await this.setTokenPriceChange24h(tokenAddress, chain, change);
        } catch (e) {
            console.warn(`refreshPriceChange24h failed for ${tokenAddress}:`, e.message);
        }
    }

    async checkPriceDataExists(transactionHash, chain = getEvmChainSlug()) {
        // Normalize tx hash for consistent lookup (EVM: lowercase, Solana: as-is)
        const normalized = (isSolanaChain(chain) ? String(transactionHash || '') : String(transactionHash || '').toLowerCase());
        if (!normalized) return false;
        const { data, error } = await supabase
            .from('token_price_data')
            .select('id')
            .eq('transaction_hash', normalized)
            .single();

        if (error && error.code !== 'PGRST116') throw error;
        return !!data;
    }

    // ============================================
    // TRADE HISTORY
    // ============================================
    async addTradeHistory(tradeData) {
        const chain = tradeData.chain || getEvmChainSlug();
        // Solana addresses are base58, don't lowercase them
        const normalizeAddress = (addr) => isSolanaChain(chain) ? String(addr || '') : String(addr || '').toLowerCase();
        // Solana transaction hashes are base58, don't lowercase them
        const normalizeTxHash = (hash) => isSolanaChain(chain) ? String(hash || '') : String(hash || '').toLowerCase();
        const normalizedTxHash = normalizeTxHash(tradeData.transactionHash);

        // Check if trade already exists (duplicate check)
        const existingTrade = await supabase
            .from('trade_history')
            .select('id')
            .eq('transaction_hash', normalizedTxHash)
            .eq('chain', chain)
            .single();

        if (existingTrade.data) {
            // Trade already exists, return existing record
            console.log(`  ℹ Trade ${normalizedTxHash} already exists, skipping insert`);
            return this.transformTradeHistory(existingTrade.data);
        }

        const { data, error } = await supabase
            .from('trade_history')
            .insert({
                token_address: normalizeAddress(tradeData.tokenAddress),
                bonding_curve_address: normalizeAddress(tradeData.bondingCurveAddress),
                chain: chain,
                trader: normalizeAddress(tradeData.trader),
                is_buy: tradeData.isBuy,
                eth_amount: tradeData.ethAmount,
                token_amount: tradeData.tokenAmount,
                price: tradeData.price,
                transaction_hash: normalizedTxHash,
                block_number: tradeData.blockNumber,
                timestamp: tradeData.timestamp
            })
            .select()
            .single();

        if (error) {
            // Handle duplicate key error gracefully
            if (error.code === '23505' || error.code === 'PGRST204' || 
                (error.message && error.message.includes('duplicate key'))) {
                console.log(`  ℹ Trade ${normalizedTxHash} already exists (race condition), fetching existing record`);
                // Fetch the existing record
                const { data: existingData, error: fetchError } = await supabase
                    .from('trade_history')
                    .select('*')
                    .eq('transaction_hash', normalizedTxHash)
                    .eq('chain', chain)
                    .single();
                
                if (fetchError) throw fetchError;
                return this.transformTradeHistory(existingData);
            }
            throw error;
        }
        return this.transformTradeHistory(data);
    }

    /**
     * Check if a Solana transaction has already been processed (exists in trade_history).
     * Used by Solana event listener to skip getTransaction RPC for already-confirmed txs and avoid 429.
     */
    async isSolanaTransactionProcessed(signature) {
        if (!signature) return false;
        const { data, error } = await supabase
            .from('trade_history')
            .select('id')
            .eq('transaction_hash', String(signature))
            .eq('chain', 'solana')
            .limit(1)
            .maybeSingle();
        if (error) return false;
        return !!data;
    }

    // ============================================
    // TOKEN HOLDERS (on-chain balance index)
    // ============================================
    /** Active tokens (token + bonding curve + creation block) for the holder indexer. */
    async getActiveTokensForHolderSync(chain = null) {
        let q = supabase
            .from('tokens')
            .select('token_address, bonding_curve_address, chain, block_number')
            .eq('status', 'active');
        if (chain) q = q.eq('chain', chain);
        const { data, error } = await q;
        if (error) { console.error('getActiveTokensForHolderSync:', error.message); return []; }
        return (data || []).map((t) => ({
            tokenAddress: t.token_address,
            bondingCurveAddress: t.bonding_curve_address,
            chain: t.chain || getEvmChainSlug(),
            blockNumber: Number(t.block_number || 0),
        }));
    }

    /** Upsert one holder's raw balance. A zero balance removes the row. */
    async upsertTokenHolder(chain, tokenAddress, walletAddress, balance) {
        const tok = normalizeAddress(tokenAddress, chain);
        const wal = normalizeAddress(walletAddress, chain);
        const bal = String(balance == null ? '0' : balance);
        if (bal === '' || /^0+$/.test(bal)) {
            return this.deleteTokenHolder(chain, tokenAddress, walletAddress);
        }
        const { error } = await supabase
            .from('token_holders')
            .upsert(
                { chain, token_address: tok, wallet_address: wal, balance: bal, updated_at: new Date().toISOString() },
                { onConflict: 'chain,token_address,wallet_address' }
            );
        if (error) throw error;
    }

    async deleteTokenHolder(chain, tokenAddress, walletAddress) {
        const tok = normalizeAddress(tokenAddress, chain);
        const wal = normalizeAddress(walletAddress, chain);
        await supabase.from('token_holders').delete().eq('chain', chain).eq('token_address', tok).eq('wallet_address', wal);
    }

    async getTokenHolders(chain, tokenAddress, limit = 1000) {
        const tok = normalizeAddress(tokenAddress, chain);
        const { data, error } = await supabase
            .from('token_holders')
            .select('wallet_address, balance, updated_at')
            .eq('chain', chain)
            .eq('token_address', tok)
            .limit(limit);
        if (error) { console.error('getTokenHolders:', error.message); return []; }
        return data || [];
    }

    /** Replace the full holder set for a token (Solana full scan): upsert current, delete the rest. */
    async replaceTokenHolders(chain, tokenAddress, holders) {
        const tok = normalizeAddress(tokenAddress, chain);
        const keep = new Set();
        if (holders.length > 0) {
            const rows = holders.map((h) => {
                const wal = normalizeAddress(h.wallet, chain);
                keep.add(wal);
                return { chain, token_address: tok, wallet_address: wal, balance: String(h.balance), updated_at: new Date().toISOString() };
            });
            const { error } = await supabase.from('token_holders').upsert(rows, { onConflict: 'chain,token_address,wallet_address' });
            if (error) throw error;
        }
        const { data: existing } = await supabase.from('token_holders').select('wallet_address').eq('chain', chain).eq('token_address', tok);
        const stale = (existing || []).map((r) => r.wallet_address).filter((w) => !keep.has(w));
        if (stale.length > 0) {
            await supabase.from('token_holders').delete().eq('chain', chain).eq('token_address', tok).in('wallet_address', stale);
        }
    }

    async getTradeHistoryByToken(tokenAddress, limit = 100, chain = null) {
        // Solana addresses are base58, don't lowercase them
        const normalizedAddress = isSolanaChain(chain) ? tokenAddress : tokenAddress.toLowerCase();
        const { data, error } = await supabase
            .from('trade_history')
            .select('*')
            .eq('token_address', normalizedAddress)
            .order('timestamp', { ascending: false })
            .limit(limit);

        if (error) throw error;
        return data.map(t => this.transformTradeHistory(t));
    }

    async getTradeHistoryByTrader(trader, limit = 100) {
        const { data, error } = await supabase
            .from('trade_history')
            .select('*')
            .eq('trader', trader.toLowerCase())
            .order('timestamp', { ascending: false })
            .limit(limit);

        if (error) throw error;
        return data.map(t => this.transformTradeHistory(t));
    }

    // ============================================
    // TRADER FEES (Solana TRADER_FEE events and EVM TraderFee events)
    // ============================================
    async insertTraderFee(feeData) {
        const chain = feeData.chain || 'solana';
        // Normalize addresses based on chain
        const walletAddress = isSolanaChain(chain) 
            ? String(feeData.walletAddress || '').trim()
            : String(feeData.walletAddress || '').toLowerCase().trim();
        const mint = isSolanaChain(chain)
            ? String(feeData.mint || '').trim()
            : String(feeData.mint || '').toLowerCase().trim();
        const txHash = isSolanaChain(chain)
            ? String(feeData.transactionHash || '')
            : String(feeData.transactionHash || '').toLowerCase();
            
        if (!walletAddress || !mint) {
            throw new Error('trader_fees: wallet_address and mint are required');
        }
        
        const insertData = {
            wallet_address: walletAddress,
            mint,
            trade_type: !!feeData.tradeType,
            platform_fee: String(feeData.platformFee ?? '0'),
            creator_fee: String(feeData.creatorFee ?? '0'),
            reward_fee: String(feeData.rewardFee ?? '0'),
            fee_amount: String(feeData.feeAmount ?? '0'),
            transaction_hash: txHash,
            slot: feeData.slot ?? null,
            block_time: feeData.blockTime ?? null
        };
        
        // Add chain column if migration has been run
        if (chain) {
            insertData.chain = chain;
        }
        
        const { data, error } = await supabase
            .from('trader_fees')
            .insert(insertData)
            .select()
            .single();
        if (error) throw error;
        return this.transformTraderFee(data);
    }

    /**
     * Check if a trader fee record already exists for this transaction (avoids duplicate inserts).
     * Use this for EVM/Solana when deciding whether to process a TraderFee event.
     * @param {string} transactionHash - Normalized tx hash
     * @param {string} chain - 'solana' | 'evm'
     * @returns {Promise<boolean>}
     */
    async checkTraderFeeExists(transactionHash, chain = getEvmChainSlug()) {
        const normalized = (isSolanaChain(chain) ? String(transactionHash || '') : String(transactionHash || '').toLowerCase());
        if (!normalized) return false;
        let query = supabase
            .from('trader_fees')
            .select('id')
            .eq('transaction_hash', normalized);
        if (chain) query = query.eq('chain', chain);
        const { data, error } = await query.limit(1).maybeSingle();
        if (error) {
            if (error.message && error.message.includes('chain')) {
                const retry = supabase.from('trader_fees').select('id').eq('transaction_hash', normalized).limit(1).maybeSingle();
                const { data: retryData, error: retryError } = await retry;
                if (retryError) throw retryError;
                return !!retryData;
            }
            throw error;
        }
        return !!data;
    }

    /**
     * Get unclaimed trader fees for a wallet (optionally filtered by chain).
     * trader_fees is one table for both Solana and EVM; chain column distinguishes rows.
     * @param {string} walletAddress - Wallet address (normalized per chain)
     * @param {string} [chain] - Optional: 'solana' | 'evm'. If provided, only rows for this chain are returned.
     */
    async getUnclaimedTraderFeesByWallet(walletAddress, chain = null) {
        const wallet = String(walletAddress || '').trim();
        if (!wallet) return [];
        let query = supabase
            .from('trader_fees')
            .select('*')
            .eq('wallet_address', wallet)
            .eq('claimed', false)
            .order('created_at', { ascending: true });
        if (chain) {
            query = query.eq('chain', chain);
        }
        const { data, error } = await query;
        if (error) {
            // If chain column doesn't exist (pre-migration), retry without chain filter
            if (error.message && error.message.includes('chain')) {
                const retryQuery = supabase
                    .from('trader_fees')
                    .select('*')
                    .eq('wallet_address', wallet)
                    .eq('claimed', false)
                    .order('created_at', { ascending: true });
                const { data: retryData, error: retryError } = await retryQuery;
                if (retryError) throw retryError;
                return (retryData || []).map(row => this.transformTraderFee(row));
            }
            throw error;
        }
        return (data || []).map(row => this.transformTraderFee(row));
    }

    /**
     * All-time cumulative reward_fee for a wallet on a chain, as a stringified BigInt (wei on EVM).
     * This is the source of truth for the signed-voucher claim: the wallet is entitled to claim back
     * the reward fees its own trades generated, and the on-chain RewardClaim contract tracks how much
     * has already been withdrawn. (No 'claimed' filter — the contract, not the DB, records claims.)
     */
    async getCumulativeRewardFeeByWallet(walletAddress, chain) {
        const wallet = String(walletAddress || '').trim();
        if (!wallet) return '0';
        let query = supabase.from('trader_fees').select('reward_fee').eq('wallet_address', wallet);
        if (chain) query = query.eq('chain', chain);
        const { data, error } = await query;
        if (error) { console.error('getCumulativeRewardFeeByWallet:', error.message); return '0'; }
        let total = 0n;
        for (const row of (data || [])) {
            try { total += BigInt(row.reward_fee || '0'); } catch { /* skip malformed */ }
        }
        return total.toString();
    }

    // ── reward_claims: per-wallet cumulative claimed + in-flight lock (restart-safe) ─────────────
    /** The reward_claims row for (chain, wallet), or null. */
    async getRewardClaimRecord(chain, wallet) {
        const { data, error } = await supabase
            .from('reward_claims')
            .select('*')
            .eq('chain', chain)
            .eq('wallet', wallet)
            .maybeSingle();
        if (error) { console.error('getRewardClaimRecord:', error.message); return null; }
        return data || null;
    }

    /** Open an in-flight claim lock (overwrites any prior pending; preserves claimed_amount). */
    async setPendingClaim(chain, wallet, amount, expiresAtIso) {
        const { error } = await supabase
            .from('reward_claims')
            .upsert(
                { chain, wallet, pending_amount: String(amount), pending_signature: null, pending_expires_at: expiresAtIso, updated_at: new Date().toISOString() },
                { onConflict: 'chain,wallet' }
            );
        if (error) throw new Error('setPendingClaim: ' + error.message);
    }

    /** Record the submitted tx signature on the in-flight lock (so reconcile can verify it). */
    async attachPendingSignature(chain, wallet, signature) {
        const { error } = await supabase
            .from('reward_claims')
            .update({ pending_signature: signature, updated_at: new Date().toISOString() })
            .eq('chain', chain).eq('wallet', wallet);
        if (error) throw new Error('attachPendingSignature: ' + error.message);
    }

    /** Add `addAmount` to cumulative claimed and clear the in-flight lock. Returns new cumulative. */
    async finalizeClaim(chain, wallet, addAmount) {
        const rec = await this.getRewardClaimRecord(chain, wallet);
        const next = (BigInt((rec && rec.claimed_amount) || '0') + BigInt(String(addAmount))).toString();
        const { error } = await supabase
            .from('reward_claims')
            .upsert(
                { chain, wallet, claimed_amount: next, pending_amount: null, pending_signature: null, pending_expires_at: null, updated_at: new Date().toISOString() },
                { onConflict: 'chain,wallet' }
            );
        if (error) throw new Error('finalizeClaim: ' + error.message);
        return next;
    }

    /** Drop the in-flight lock without changing claimed_amount (expired / failed claim). */
    async clearPendingClaim(chain, wallet) {
        const { error } = await supabase
            .from('reward_claims')
            .update({ pending_amount: null, pending_signature: null, pending_expires_at: null, updated_at: new Date().toISOString() })
            .eq('chain', chain).eq('wallet', wallet);
        if (error) console.error('clearPendingClaim:', error.message);
    }

    async markTraderFeesAsClaimed(ids, claimTxSignature = null) {
        if (!ids || !Array.isArray(ids) || ids.length === 0) return;
        const { error } = await supabase
            .from('trader_fees')
            .update({ claimed: true, claimed_at: new Date().toISOString() })
            .in('id', ids);
        if (error) throw error;
    }

    /**
     * Get aggregated fee amounts for reward distribution: total sum and per-wallet sum.
     * Used for the current distribution window (all rows in trader_fees before cleanup).
     * @param {string} chain - 'solana' | 'evm' (optional, if not provided returns all chains)
     * @returns { Promise<{ totalFeeLamports: string, byWallet: Array<{ walletAddress: string, feeLamports: string }> }> }
     */
    async getTraderFeeAggregatesForReward(chain = null) {
        let query = supabase
            .from('trader_fees')
            .select('wallet_address, fee_amount, chain');
        
        if (chain) {
            query = query.eq('chain', chain);
        }
        
        const { data: rows, error } = await query;
        if (error) {
            // If chain column doesn't exist, retry without it
            if (error.message && error.message.includes('chain')) {
                const retryQuery = supabase
                    .from('trader_fees')
                    .select('wallet_address, fee_amount');
                const { data: retryRows, error: retryError } = await retryQuery;
                if (retryError) throw retryError;
                const byWallet = new Map();
                let total = 0n;
                for (const r of retryRows || []) {
                    const amt = BigInt(String(r.fee_amount || '0'));
                    if (amt <= 0n) continue;
                    total += amt;
                    const w = String(r.wallet_address || '').trim();
                    if (!w) continue;
                    byWallet.set(w, (byWallet.get(w) || 0n) + amt);
                }
                const byWalletList = Array.from(byWallet.entries()).map(([walletAddress, feeLamports]) => ({
                    walletAddress,
                    feeLamports: String(feeLamports)
                }));
                return { totalFeeLamports: String(total), byWallet: byWalletList };
            }
            throw error;
        }
        
        const byWallet = new Map();
        let total = 0n;
        for (const r of rows || []) {
            const amt = BigInt(String(r.fee_amount || '0'));
            if (amt <= 0n) continue;
            total += amt;
            const w = String(r.wallet_address || '').trim();
            if (!w) continue;
            byWallet.set(w, (byWallet.get(w) || 0n) + amt);
        }
        const byWalletList = Array.from(byWallet.entries()).map(([walletAddress, feeLamports]) => ({
            walletAddress,
            feeLamports: String(feeLamports)
        }));
        return { totalFeeLamports: String(total), byWallet: byWalletList };
    }

    /**
     * Get total platform fees for reward distribution.
     * @param {string} chain - 'solana' | 'evm' (optional, if not provided returns all chains)
     */
    async getTotalPlatformFeeAggregatesForReward(chain = null) {
        let query = supabase
            .from('trader_fees')
            .select('platform_fee, chain');
        
        if (chain) {
            query = query.eq('chain', chain);
        }
        
        const { data, error } = await query;
        if (error) {
            // If chain column doesn't exist, retry without it
            if (error.message && error.message.includes('chain')) {
                const retryQuery = supabase
                    .from('trader_fees')
                    .select('platform_fee');
                const { data: retryData, error: retryError } = await retryQuery;
                if (retryError) throw retryError;
                let total = 0n;
                for (const r of retryData || []) {
                    const amt = BigInt(String(r.platform_fee || '0'));
                    if (amt <= 0n) continue;
                    total += amt;
                }
                return { totalPlatformFeeLamports: String(total) };
            }
            throw error;
        }
        
        let total = 0n;
        for (const r of data || []) {
            const amt = BigInt(String(r.platform_fee || '0'));
            if (amt <= 0n) continue;
            total += amt;
        }
        return { totalPlatformFeeLamports: String(total) };
    }

    /**
     * Compute eligible reward aggregates for one distribution round with wash-trade filtering.
     *
     * Eligibility rule: for each (wallet_address, mint) pair, a trade is eligible only if
     * the previous trade by the same wallet on the same mint was at least `cooldownSeconds` ago.
     * This prevents rapid buy/sell cycling of the same token from gaming the rewards pool.
     *
     * Returns per-wallet sums of eligible reward_fee and the grand total.
     *
     * @param {string} chain
     * @param {number} cooldownSeconds - Min seconds between eligible trades for same wallet+mint
     * @param {string} beforeIso - Only consider rows with created_at < this timestamp
     * @returns {Promise<{ totalRewardLamports: string, byWallet: Array<{ walletAddress: string, rewardLamports: string }> }>}
     */
    async getEligibleRewardAggregates(chain, cooldownSeconds = 300, beforeIso = null) {
        // Fetch all relevant rows ordered by (wallet, mint, created_at)
        let query = supabase
            .from('trader_fees')
            .select('wallet_address, mint, reward_fee, created_at')
            .eq('chain', chain)
            .order('wallet_address', { ascending: true })
            .order('mint', { ascending: true })
            .order('created_at', { ascending: true });

        if (beforeIso) {
            query = query.lt('created_at', beforeIso);
        }

        const { data: rows, error } = await query;
        if (error) throw error;

        const cooldownMs = cooldownSeconds * 1000;
        const byWallet = new Map();
        let total = 0n;

        // Track last eligible timestamp per (wallet, mint)
        const lastEligible = new Map();

        for (const r of rows || []) {
            const rewardFee = BigInt(String(r.reward_fee || '0'));
            if (rewardFee <= 0n) continue;

            const key = `${r.wallet_address}::${r.mint}`;
            const tradeTime = new Date(r.created_at).getTime();
            const prev = lastEligible.get(key);

            // Eligible if: first trade for this (wallet, mint) pair,
            // or at least cooldownSeconds since last eligible trade
            if (prev === undefined || (tradeTime - prev) >= cooldownMs) {
                lastEligible.set(key, tradeTime);
                total += rewardFee;
                const w = String(r.wallet_address || '').trim();
                if (w) byWallet.set(w, (byWallet.get(w) || 0n) + rewardFee);
            }
        }

        const byWalletList = Array.from(byWallet.entries()).map(([walletAddress, rewardLamports]) => ({
            walletAddress,
            rewardLamports: String(rewardLamports)
        }));

        return { totalRewardLamports: String(total), byWallet: byWalletList };
    }

    /**
     * Delete trader_fees rows where created_at < cutoff (after distribution).
     * @param {string} cutoffIso - ISO timestamp; rows with created_at < this are deleted
     * @param {string} chain - 'solana' | 'evm' (optional, if not provided deletes all chains)
     * @returns { Promise<number> } - number of rows deleted
     */
    async deleteTraderFeesOlderThan(cutoffIso, chain = null) {
        let query = supabase
            .from('trader_fees')
            .delete()
            .lt('created_at', cutoffIso);
        
        if (chain) {
            query = query.eq('chain', chain);
        }
        
        const { data, error } = await query.select('id');
        if (error) {
            // If chain column doesn't exist, retry without it
            if (error.message && error.message.includes('chain')) {
                const retryQuery = supabase
                    .from('trader_fees')
                    .delete()
                    .lt('created_at', cutoffIso);
                const { data: retryData, error: retryError } = await retryQuery.select('id');
                if (retryError) throw retryError;
                return (retryData || []).length;
            }
            throw error;
        }
        return (data || []).length;
    }

    /**
     * Distinct chain slugs that may need a reward round (Solana + this deployment’s EVM slug + any present in DB).
     */
    async getChainsToDistribute() {
        const slug = getEvmChainSlug();
        const chains = new Set(['solana', slug]);
        const { data: feeRows } = await supabase.from('trader_fees').select('chain');
        for (const r of feeRows || []) {
            if (r && r.chain) chains.add(String(r.chain));
        }
        const { data: tokenRows } = await supabase
            .from('tokens')
            .select('chain')
            .gt('fee_amount', '0');
        for (const r of tokenRows || []) {
            if (r && r.chain) chains.add(String(r.chain));
        }
        return Array.from(chains);
    }

    // ============================================
    // CREATOR FEES (per-token fee_amount in tokens table)
    // ============================================

    /**
     * Add creator fee to a token's fee_amount (accumulated per round for distribution).
     * @param {string} tokenAddress - Token mint address (token_address in tokens table)
     * @param {string} chain - 'solana' | 'evm'
     * @param {string|bigint|number} amountLamports - Creator fee amount (lamports for Solana) to add
     */
    async incrementTokenCreatorFee(tokenAddress, chain, amountLamports) {
        const token = await this.getTokenByAddress(tokenAddress, chain);
        if (!token) return;
        const current = BigInt(token.feeAmount || '0');
        const add = typeof amountLamports === 'bigint' ? amountLamports : BigInt(String(amountLamports));
        if (add <= 0n) return;
        const next = current + add;
        const { error } = await supabase
            .from('tokens')
            .update({
                fee_amount: String(next),
                updated_at: new Date().toISOString()
            })
            .eq('token_address', isSolanaChain(chain) ? tokenAddress : tokenAddress.toLowerCase())
            .eq('chain', chain);
        if (error) throw error;
    }

    /**
     * Get tokens created by a specific wallet with their fee_amount.
     * @param {string} creatorAddress - Wallet address of the creator
     * @param {string} chain - 'solana' | 'evm' (default 'solana')
     * @returns { Promise<Array<{ tokenAddress: string, creator: string, feeAmount: string }>> }
     */
    async getTokensByCreatorWithFees(creatorAddress, chain = 'solana') {
        const { data, error } = await supabase
            .from('tokens')
            .select('token_address, creator, fee_amount')
            .eq('chain', chain)
            .eq('creator', creatorAddress);
        if (error) throw error;
        return (data || []).map((r) => ({
            tokenAddress: r.token_address,
            creator: r.creator,
            feeAmount: String(r.fee_amount || '0')
        }));
    }

    /**
     * Get tokens that have creator fees to distribute (fee_amount > 0).
     * @param {string} chain - 'solana' | 'evm' (default 'solana')
     * @returns { Promise<Array<{ tokenAddress: string, creator: string, feeAmount: string }>> }
     */
    async getTokensWithCreatorFeesToDistribute(chain = 'solana') {
        const { data, error } = await supabase
            .from('tokens')
            .select('token_address, creator, fee_amount')
            .eq('chain', chain)
            .gt('fee_amount', '0');
        if (error) throw error;
        return (data || [])
            .filter((r) => BigInt(String(r.fee_amount || '0')) > 0n)
            .map((r) => ({
                tokenAddress: r.token_address,
                creator: r.creator,
                feeAmount: String(r.fee_amount || '0')
            }));
    }

    /**
     * Reset a token's fee_amount to 0 after creator distribution.
     * @param {string} tokenAddress - Token mint address
     * @param {string} chain - 'solana' | 'evm'
     */
    async resetTokenCreatorFee(tokenAddress, chain = 'solana') {
        const { error } = await supabase
            .from('tokens')
            .update({
                fee_amount: '0',
                updated_at: new Date().toISOString()
            })
            .eq('token_address', isSolanaChain(chain) ? tokenAddress : tokenAddress.toLowerCase())
            .eq('chain', chain);
        if (error) throw error;
    }

    /**
     * Get reward distribution config (single row). Creates default if none exists.
     * @returns { Promise<{ cycle: string, rewardRatio: number, nextDistributionAt: string, minimumRewardLamports: string }> }
     */
    async getRewardDistributionConfig() {
        const { data, error } = await supabase
            .from('reward_distribution_config')
            .select('*')
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle();
        if (error) throw error;
        if (data) {
            return {
                cycle: data.cycle,
                rewardRatio: Number(data.reward_ratio),
                nextDistributionAt: data.next_distribution_at,
                minimumRewardLamports: String(data.minimum_reward_lamports || '1000'),
                washTradeCooldownSeconds: Number(data.wash_trade_cooldown_seconds ?? 300)
            };
        }
        const now = new Date();
        const nextAt = new Date(now.getTime() + 5 * 60 * 1000);
        const { data: inserted, error: insertErr } = await supabase
            .from('reward_distribution_config')
            .insert({
                cycle: '5min',
                reward_ratio: 0.5,
                next_distribution_at: nextAt.toISOString(),
                minimum_reward_lamports: 1000,
                wash_trade_cooldown_seconds: 300
            })
            .select()
            .single();
        if (insertErr) throw insertErr;
        return {
            cycle: inserted.cycle,
            rewardRatio: Number(inserted.reward_ratio),
            nextDistributionAt: inserted.next_distribution_at,
            minimumRewardLamports: String(inserted.minimum_reward_lamports || '1000'),
            washTradeCooldownSeconds: Number(inserted.wash_trade_cooldown_seconds ?? 300)
        };
    }

    /**
     * Update reward distribution config (updates the first row or inserts).
     * @param { { cycle?: string, rewardRatio?: number, nextDistributionAt?: string, minimumRewardLamports?: number } } updates
     */
    async updateRewardDistributionConfig(updates) {
        const { data: existing } = await supabase
            .from('reward_distribution_config')
            .select('id')
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle();
        const payload = {};
        if (updates.cycle != null) payload.cycle = updates.cycle;
        if (updates.rewardRatio != null) payload.reward_ratio = updates.rewardRatio;
        if (updates.nextDistributionAt != null) payload.next_distribution_at = updates.nextDistributionAt;
        if (updates.minimumRewardLamports != null) payload.minimum_reward_lamports = updates.minimumRewardLamports;
        if (updates.washTradeCooldownSeconds != null) payload.wash_trade_cooldown_seconds = updates.washTradeCooldownSeconds;
        payload.updated_at = new Date().toISOString();
        if (existing?.id) {
            const { error } = await supabase
                .from('reward_distribution_config')
                .update(payload)
                .eq('id', existing.id);
            if (error) throw error;
        } else {
            const { error } = await supabase
                .from('reward_distribution_config')
                .insert({
                    cycle: payload.cycle ?? '5min',
                    reward_ratio: payload.reward_ratio ?? 0.5,
                    next_distribution_at: payload.next_distribution_at ?? new Date(Date.now() + 5 * 60 * 1000).toISOString(),
                    minimum_reward_lamports: payload.minimum_reward_lamports ?? 1000,
                    updated_at: payload.updated_at
                });
            if (error) throw error;
        }
    }

    /**
     * Insert a reward distribution run record for auditing.
     * @param { { distributionAt: string, cycle: string, rewardRatio: number, totalFeesLamports: string, totalRewardsLamports: string, traderCount: number, successCount: number, failCount: number } } run
     */
    /**
     * Insert a reward distribution run record (one table; run can be for both chains).
     * @param {Object} run - Run data; chain is optional ('all' when distributing both Solana and EVM).
     */
    async insertRewardDistributionRun(run) {
        const insertPayload = {
            distribution_at: run.distributionAt,
            cycle: run.cycle,
            reward_ratio: run.rewardRatio,
            total_fees_lamports: run.totalFeesLamports,
            total_rewards_lamports: run.totalRewardsLamports,
            trader_count: run.traderCount,
            success_count: run.successCount,
            fail_count: run.failCount
        };
        if (run.chain != null) {
            insertPayload.chain = run.chain;
        }
        const { error } = await supabase
            .from('reward_distribution_runs')
            .insert(insertPayload);
        if (error) {
            // If chain column doesn't exist, retry without it
            if (error.message && error.message.includes('chain')) {
                delete insertPayload.chain;
                const { error: retryError } = await supabase
                    .from('reward_distribution_runs')
                    .insert(insertPayload);
                if (retryError) throw retryError;
                return;
            }
            throw error;
        }
    }

    transformTraderFee(data) {
        if (!data) return null;
        return {
            id: data.id,
            walletAddress: data.wallet_address,
            mint: data.mint,
            chain: data.chain || 'solana',
            tradeType: data.trade_type,
            platformFee: data.platform_fee,
            creatorFee: data.creator_fee,
            rewardFee: data.reward_fee ?? '0',
            feeAmount: data.fee_amount,
            transactionHash: data.transaction_hash,
            slot: data.slot,
            blockTime: data.block_time,
            claimed: data.claimed,
            claimedAt: data.claimed_at,
            createdAt: data.created_at
        };
    }

    // ============================================
    // PROFILES
    // ============================================
    async getProfile(walletAddress) {
        const { data, error } = await supabase
            .from('profiles')
            .select('*')
            .eq('wallet_address', walletAddress.toLowerCase())
            .single();

        if (error && error.code !== 'PGRST116') throw error;
        return data ? this.transformProfile(data) : null;
    }

    async upsertProfile(profileData) {
        const { data, error } = await supabase
            .from('profiles')
            .upsert({
                wallet_address: profileData.walletAddress.toLowerCase(),
                username: profileData.username || null,
                bio: profileData.bio || '',
                avatar_url: profileData.avatarUrl || '',
                banner_url: profileData.bannerUrl || '',
                twitter: profileData.twitter || '',
                telegram: profileData.telegram || '',
                website: profileData.website || ''
            }, { onConflict: 'wallet_address' })
            .select()
            .single();

        if (error) throw error;
        return this.transformProfile(data);
    }

    // ============================================
    // TRANSFORM HELPERS (snake_case to camelCase)
    // ============================================
    transformToken(data) {
        if (!data) return null;
        return {
            id: data.id,
            tokenAddress: data.token_address,
            bondingCurveAddress: data.bonding_curve_address,
            chain: data.chain || getEvmChainSlug(),
            creator: data.creator,
            name: data.name,
            symbol: data.symbol,
            description: data.description,
            website: data.website,
            twitter: data.twitter,
            telegram: data.telegram,
            discord: data.discord,
            logoUrl: data.logo_url,
            bannerUrl: data.banner_url,
            totalSupply: data.total_supply,
            decimals: data.decimals,
            transactionHash: data.transaction_hash,
            blockNumber: data.block_number,
            timestamp: data.timestamp,
            initialPrice: data.initial_price,
            feeAmount: data.fee_amount,
            status: data.status,
            createdAt: data.created_at,
            updatedAt: data.updated_at
        };
    }

    transformBondingCurve(data) {
        if (!data) return null;
        return {
            id: data.id,
            bondingCurveAddress: data.bonding_curve_address,
            tokenAddress: data.token_address,
            chain: data.chain || getEvmChainSlug(),
            creator: data.creator,
            virtualEthLp: data.virtual_eth_lp,
            virtualTokenLp: data.virtual_token_lp,
            realEthLp: data.real_eth_lp,
            realTokenLp: data.real_token_lp,
            k: data.k,
            tokenStartPrice: data.token_start_price,
            currentPrice: data.current_price,
            volume: data.volume,
            totalTrades: data.total_trades,
            totalBuyers: data.total_buyers,
            totalSellers: data.total_sellers,
            lpCreated: data.lp_created,
            liquidityTokenId: data.liquidity_token_id,
            liquidityLockDurationSeconds: data.liquidity_lock_duration_seconds ?? null,
            liquidityUnlockTimestamp: data.liquidity_unlock_timestamp ?? null,
            lpUnlocked: data.lp_unlocked ?? false,
            startTimestamp: data.start_timestamp,
            transactionHash: data.transaction_hash,
            blockNumber: data.block_number,
            status: data.status,
            createdAt: data.created_at,
            updatedAt: data.updated_at
        };
    }

    transformChatMessage(data) {
        if (!data) return null;
        return {
            id: data.id,
            tokenAddress: data.token_address,
            ShitlordAddress: data.token_address, // Legacy field name
            sender: data.sender,
            content: data.content,
            imageUrl: data.image_url,
            timestamp: data.timestamp,
            createdAt: data.created_at
        };
    }

    transformPriceData(data) {
        if (!data) return null;
        return {
            id: data.id,
            tokenAddress: data.token_address,
            timestamp: data.timestamp,
            openPrice: data.open_price,
            closePrice: data.close_price,
            amount: data.amount,
            trader: data.trader,
            isBuy: data.is_buy,
            transactionHash: data.transaction_hash,
            blockNumber: data.block_number,
            createdAt: data.created_at
        };
    }

    transformTradeHistory(data) {
        if (!data) return null;
        return {
            id: data.id,
            tokenAddress: data.token_address,
            bondingCurveAddress: data.bonding_curve_address,
            chain: data.chain || getEvmChainSlug(),
            trader: data.trader,
            isBuy: data.is_buy,
            ethAmount: data.eth_amount,
            tokenAmount: data.token_amount,
            price: data.price,
            transactionHash: data.transaction_hash,
            blockNumber: data.block_number,
            timestamp: data.timestamp,
            createdAt: data.created_at
        };
    }

    transformProfile(data) {
        if (!data) return null;
        return {
            id: data.id,
            walletAddress: data.wallet_address,
            username: data.username,
            bio: data.bio,
            avatarUrl: data.avatar_url,
            bannerUrl: data.banner_url,
            twitter: data.twitter,
            telegram: data.telegram,
            website: data.website,
            createdAt: data.created_at,
            updatedAt: data.updated_at
        };
    }

    mapSortColumn(sortBy, type) {
        const tokenMap = {
            timestamp: 'timestamp',
            createdAt: 'created_at'
        };
        const bondingCurveMap = {
            startTimestamp: 'start_timestamp',
            volume: 'volume',
            createdAt: 'created_at'
        };
        
        if (type === 'token') return tokenMap[sortBy] || 'timestamp';
        if (type === 'bondingCurve') return bondingCurveMap[sortBy] || 'start_timestamp';
        return sortBy;
    }
}

module.exports = new SupabaseService();

