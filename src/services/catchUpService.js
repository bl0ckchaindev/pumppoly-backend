const ethers = require("ethers");
const { httpRpcUrl } = require('../config');
const supabaseService = require('./supabaseService');
const { getEvmChainSlug } = require('../lib/chainUtils');
const tokenService = require('./tokenService');

// Load full ABI from JSON file
const BONDING_CURVE_ABI = require('../abi/BondingCurveABI.json');

class CatchUpService {
    constructor() {
        this.provider = null;
        this.isRunning = false;
    }

    /**
     * Initialize provider for catch-up operations
     */
    async initialize() {
        try {
            if (this.provider) {
                return; // Already initialized
            }

            // Use HTTP provider for catch-up (more reliable for batch queries)
            if (httpRpcUrl) {
                this.provider = new ethers.providers.JsonRpcProvider(httpRpcUrl);
                console.log('Catch-up service initialized with HTTP provider');
            } else {
                throw new Error('No HTTP RPC URL configured for catch-up service');
            }
        } catch (error) {
            console.error('Failed to initialize catch-up service:', error);
            throw error;
        }
    }

    /**
     * Catch up on missed events for a specific bonding curve
     * @param {string} contractAddress - Bonding curve contract address
     * @param {number} fromBlock - Starting block (optional, will use last processed block if not provided)
     * @returns {Promise<Object>} Catch-up result
     */
    async catchUpBondingCurve(contractAddress) {
        try {
            if (!this.provider) {
                await this.initialize();
            }

            const contract = new ethers.Contract(
                contractAddress.toLowerCase(),
                BONDING_CURVE_ABI,
                this.provider
            );

            // Get the latest block
            const latestBlock = await this.provider.getBlockNumber();
            
            // Get token address from bonding curve first
            const bondingCurve = await tokenService.getBondingCurveByAddress(contractAddress);
            if (!bondingCurve || !bondingCurve.tokenAddress) {
                throw new Error(`Bonding curve not found or missing token address: ${contractAddress}`);
            }
            
            // Find the last processed block for this token
            const priceData = await supabaseService.getTokenPriceData(bondingCurve.tokenAddress, 1);
            const lastEvent = priceData && priceData.length > 0 ? priceData[0] : null;

            // Use bonding curve creation block if no events found
            let startBlock = lastEvent ? lastEvent.blockNumber + 1 : null;
            
            if (!startBlock) {
                const bondingCurve = await tokenService.getBondingCurveByAddress(contractAddress);
                startBlock = bondingCurve ? bondingCurve.blockNumber : 0;
            }

            if (startBlock > latestBlock) {
                return {
                    contractAddress,
                    status: 'up_to_date',
                    eventsProcessed: 0,
                    fromBlock: startBlock,
                    toBlock: latestBlock
                };
            }

            console.log(`Catching up events for ${contractAddress} from block ${startBlock} to ${latestBlock}`);

            let totalEvents = 0;
            let totalTraderFees = 0;
            // RPC providers (like Moralis) typically limit eth_getLogs to 100 blocks per request
            const batchSize = 100;

            // Process in batches
            for (let i = startBlock; i <= latestBlock; i += batchSize) {
                const endBlock = Math.min(i + batchSize - 1, latestBlock);
                
                try {
                    const events = await contract.queryFilter(
                        contract.filters.TokenTraded(),
                        i,
                        endBlock
                    );
                    const traderFeeEvents = await contract.queryFilter(
                        contract.filters.TraderFee(),
                        i,
                        endBlock
                    );

                    if (events.length > 0 || traderFeeEvents.length > 0) {
                        console.log(`  Found ${events.length} TokenTraded and ${traderFeeEvents.length} TraderFee events in blocks ${i}-${endBlock}`);
                    }

                    // Process TokenTraded events
                    const batch = [];
                    for (const event of events) {
                        batch.push(this.processEvent(contractAddress, event));
                    }
                    const chunkSize = 10;
                    for (let j = 0; j < batch.length; j += chunkSize) {
                        const chunk = batch.slice(j, j + chunkSize);
                        await Promise.all(chunk);
                        totalEvents += chunk.length;
                    }

                    // Process TraderFee events (store in trader_fees for reward distribution)
                    for (const event of traderFeeEvents) {
                        try {
                            const txHash = typeof event.transactionHash === 'string' ? event.transactionHash.toLowerCase() : event.transactionHash;
                            if (await supabaseService.checkTraderFeeExists(txHash, getEvmChainSlug())) continue;
                            await this.processTraderFeeEvent(contractAddress, event);
                            totalTraderFees++;
                        } catch (err) {
                            if (err.message && !err.message.includes('duplicate key') && !err.message.includes('unique constraint') && err.code !== '23505') {
                                console.error(`  Error processing TraderFee ${event.transactionHash}:`, err.message);
                            }
                        }
                    }
                } catch (error) {
                    console.error(`Error processing blocks ${i}-${endBlock} for ${contractAddress}:`, error.message);
                    if (error.message && error.message.includes('Exceeded maximum block range')) {
                        console.error(`  ⚠ RPC provider block range limit exceeded. Consider reducing batch size further.`);
                    }
                }
                
                if (i + batchSize <= latestBlock) {
                    await new Promise(resolve => setTimeout(resolve, 100));
                }
            }

            if (totalTraderFees > 0) {
                console.log(`  Stored ${totalTraderFees} TraderFee record(s) for ${contractAddress}`);
            }

            return {
                contractAddress,
                status: 'completed',
                eventsProcessed: totalEvents,
                traderFeesProcessed: totalTraderFees,
                fromBlock: startBlock,
                toBlock: latestBlock
            };
        } catch (error) {
            console.error(`Error catching up bonding curve ${contractAddress}:`, error);
            return {
                contractAddress,
                status: 'error',
                error: error.message,
                eventsProcessed: 0
            };
        }
    }

    /**
     * Process a single TraderFee event (for catch-up backfill).
     * Inserts into trader_fees and optionally increments token creator fee.
     */
    async processTraderFeeEvent(contractAddress, event) {
        const toAddr = (v) => (v && typeof v === 'string' ? v : (v && typeof v.toString === 'function' ? v.toString() : String(v || ''))).toLowerCase();
        const [trader, tokenAddress, tradeType, platformFee, creatorFee, feeAmount] = event.args;
        const tokenAddressLower = toAddr(tokenAddress);
        const traderLower = toAddr(trader);
        const eventBlockNumber = event.blockNumber && event.blockNumber.toNumber ? event.blockNumber.toNumber() : Number(event.blockNumber);
        let blockTime = Math.floor(Date.now() / 1000);
        try {
            const block = await this.provider.getBlock(eventBlockNumber);
            if (block && block.timestamp) blockTime = block.timestamp;
        } catch (_) {}
        await supabaseService.insertTraderFee({
            walletAddress: traderLower,
            mint: tokenAddressLower,
            chain: getEvmChainSlug(),
            tradeType: tradeType,
            platformFee: platformFee.toString(),
            creatorFee: creatorFee.toString(),
            feeAmount: feeAmount.toString(),
            transactionHash: (typeof event.transactionHash === 'string' ? event.transactionHash : event.transactionHash).toLowerCase(),
            slot: eventBlockNumber,
            blockTime
        });
        if (creatorFee && BigInt(creatorFee.toString()) > 0n) {
            try {
                await supabaseService.incrementTokenCreatorFee(tokenAddressLower, getEvmChainSlug(), creatorFee.toString());
            } catch (incErr) {
                console.error('  Failed to increment token creator fee:', incErr.message);
            }
        }
    }

    /**
     * Process a single event
     */
    async processEvent(contractAddress, event) {
        try {
            // TokenTraded event: tokenAddress, timestamp, openPrice, closePrice, amount, tokenAmount, trader, isBuy
            const [tokenAddress, timestamp, openPrice, closePrice, amount, tokenAmount, trader, isBuy] = event.args;

            // Check if event already exists (normalize tx hash for EVM)
            const txHash = typeof event.transactionHash === 'string' ? event.transactionHash.toLowerCase() : event.transactionHash;
            const exists = await supabaseService.checkPriceDataExists(txHash, getEvmChainSlug());

            if (exists) {
                return; // Already processed
            }

            // Get token address from event (now included in TokenTraded event)
            // Ethers may return address as object; convert to string safely
            const toAddr = (v) => (v && typeof v === 'string' ? v : (v && typeof v.toString === 'function' ? v.toString() : String(v || ''))).toLowerCase();
            const tokenAddressLower = tokenAddress ? toAddr(tokenAddress) : null;
            
            // If token address not in event, get it from bonding curve
            let finalTokenAddress = tokenAddressLower;
            if (!finalTokenAddress) {
                const bondingCurve = await tokenService.getBondingCurveByAddress(contractAddress);
                if (bondingCurve && bondingCurve.tokenAddress) {
                    finalTokenAddress = bondingCurve.tokenAddress.toLowerCase();
                } else {
                    console.error(`Could not determine token address for bonding curve: ${contractAddress}`);
                    return;
                }
            }

            // Save to Supabase (using token_address instead of contract_address)
            const priceData = {
                tokenAddress: finalTokenAddress,
                timestamp: timestamp.toNumber(),
                openPrice: openPrice.toString(),
                closePrice: closePrice.toString(),
                amount: amount.toString(),
                trader: trader.toLowerCase(),
                isBuy,
                transactionHash: event.transactionHash,
                blockNumber: event.blockNumber,
                chain: getEvmChainSlug()
            };

            await supabaseService.addTokenPriceData(priceData);
            
            // Also save to trade history
            try {
                const bondingCurve = await tokenService.getBondingCurveByAddress(contractAddress);
                if (bondingCurve && bondingCurve.tokenAddress) {
                    const tradeData = {
                        tokenAddress: finalTokenAddress,
                        bondingCurveAddress: contractAddress.toLowerCase(),
                        trader: toAddr(trader),
                        isBuy,
                        ethAmount: amount.toString(),
                        tokenAmount: tokenAmount ? tokenAmount.toString() : '0',
                        price: closePrice.toString(),
                        transactionHash: event.transactionHash,
                        blockNumber: event.blockNumber,
                        timestamp: timestamp.toNumber(),
                        chain: getEvmChainSlug()
                    };
                    await supabaseService.addTradeHistory(tradeData);
                }
            } catch (err) {
                // Trade history might already exist, continue
            }

            // Update bonding curve statistics
            try {
                const bondingCurve = await tokenService.getBondingCurveByAddress(contractAddress);
                if (bondingCurve) {
                    const currentVolume = bondingCurve.volume || '0';
                    const tradeAmount = amount.toString();
                    const newVolume = (BigInt(currentVolume) + BigInt(tradeAmount)).toString();
                    
                    const updateData = {
                        currentPrice: closePrice.toString(),
                        volume: newVolume
                    };
                    
                    if (isBuy) {
                        updateData.totalBuyers = (bondingCurve.totalBuyers || 0) + 1;
                    } else {
                        updateData.totalSellers = (bondingCurve.totalSellers || 0) + 1;
                    }
                    
                    updateData.totalTrades = (bondingCurve.totalTrades || 0) + 1;
                    
                    await tokenService.updateBondingCurve(contractAddress, updateData);
                }
            } catch (error) {
                console.error(`Error updating bonding curve stats for ${contractAddress}:`, error.message);
            }
        } catch (error) {
            console.error(`Error processing event ${event.transactionHash}:`, error.message);
            throw error;
        }
    }

    /**
     * Catch up on all active bonding curves
     * @returns {Promise<Object>} Summary of catch-up results
     */
    async catchUpAllBondingCurves() {
        try {
            if (!this.provider) {
                await this.initialize();
            }

            // Only EVM bonding curves — Solana has its own event listener
            const activeBondingCurvesData = await supabaseService.getActiveBondingCurves(getEvmChainSlug());
            const activeBondingCurves = activeBondingCurvesData.map(bc => ({
                bondingCurveAddress: bc.bondingCurveAddress
            }));

            console.log(`Starting catch-up for ${activeBondingCurves.length} active bonding curves...`);

            const results = [];
            let totalEvents = 0;

            // Process bonding curves sequentially to avoid overwhelming the RPC
            for (const bc of activeBondingCurves) {
                const raw = bc.bondingCurveAddress;
                if (!raw) continue;
                // Skip Solana addresses (base58) — EVM addresses start with 0x
                if (!raw.startsWith('0x')) continue;
                const address = raw.toLowerCase();

                try {
                    const result = await this.catchUpBondingCurve(address);
                    results.push(result);
                    totalEvents += result.eventsProcessed || 0;
                    
                    // Small delay between contracts to avoid rate limiting
                    await new Promise(resolve => setTimeout(resolve, 100));
                } catch (error) {
                    console.error(`Failed to catch up ${address}:`, error.message);
                    results.push({
                        contractAddress: address,
                        status: 'error',
                        error: error.message
                    });
                }
            }

            const summary = {
                total: activeBondingCurves.length,
                completed: results.filter(r => r.status === 'completed').length,
                upToDate: results.filter(r => r.status === 'up_to_date').length,
                errors: results.filter(r => r.status === 'error').length,
                totalEventsProcessed: totalEvents,
                results
            };

            console.log(`Catch-up completed: ${summary.completed} processed, ${summary.upToDate} up-to-date, ${summary.errors} errors, ${totalEvents} total events`);
            
            return summary;
        } catch (error) {
            console.error('Error in catch-up all bonding curves:', error);
            throw error;
        }
    }
}

module.exports = new CatchUpService();

