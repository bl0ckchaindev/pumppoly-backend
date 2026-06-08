const ethers = require("ethers");
const { httpRpcUrl, wsRpcUrl, virtualEthLpInitial, virtualTokenLpInitial, realEthLpInitial, realTokenLpInitial, bondingLimit, factoryDeployBlock } = require('./config');
const supabaseService = require('./services/supabaseService');
const { getEvmChainSlug } = require('./lib/chainUtils');

// Load full ABIs from JSON files
const FACTORY_ABI = require('./abi/FactoryABI.json');
const BONDING_CURVE_ABI = require('./abi/BondingCurveABI.json');

// Consecutive poll failures before triggering recycle (800ms poll => ~24s of failures)
const POLL_FAILURE_THRESHOLD = 30;

class EventListener {
    constructor() {
        this.provider = null;
        this.bondingCurveListeners = new Map(); // Map of bondingCurveAddress -> listener data
        this.factoryListener = null;
        this.factoryAddress = null;
        this.factoryContract = null;
        this.lastFactoryBlock = null; // Track last processed factory event block
        this.catchUpInterval = null; // Periodic catch-up interval
        this.pollingInterval = null; // Polling interval for HTTP providers
        this.isWebSocket = false; // Track if using WebSocket provider
        this.lastBondingCurveBlocks = new Map(); // Track last processed block per bonding curve
        this.consecutivePollFailures = 0; // Track failures for staleness detection
        this.isRecycling = false; // Prevent overlapping recycle
        this.isPolling = false; // Prevent overlapping poll runs (setInterval does not await)
    }

    /**
     * Initialize the provider (WebSocket for real-time events)
     */
    async initialize() {
        if (this.provider) {
            return; // Already initialized
        }

        // Use WebSocket for real-time events, fallback to HTTP
        if (wsRpcUrl) {
            try {
                this.provider = new ethers.providers.WebSocketProvider(wsRpcUrl);
                this.isWebSocket = true;
                console.log('✓ Event listener initialized with WebSocket provider');
                
                // Add error handler to prevent crashes from WebSocket issues
                if (this.provider.connection && this.provider.connection._ws) {
                    const ws = this.provider.connection._ws;
                    
                    // Handle WebSocket errors
                    ws.on('error', (error) => {
                        console.error('⚠ WebSocket error:', error.message);
                        // Don't crash - will attempt to reconnect
                    });
                    
                    // Handle WebSocket close
                    ws.on('close', async () => {
                        console.log('⚠ WebSocket disconnected, reconnecting in 5s...');
                        // Clear listeners - they'll be re-established after reconnect
                        this.factoryListener = null;
                        this.factoryContract = null;
                        for (const [address, data] of this.bondingCurveListeners) {
                            if (data.listener) {
                                try {
                                    data.contract.removeAllListeners("TokenTraded");
                                    data.contract.removeAllListeners("TraderFee");
                                } catch (err) {
                                    // Ignore errors when removing listeners
                                }
                            }
                        }
                        this.bondingCurveListeners.clear();
                        this.lastBondingCurveBlocks.clear();

                        // Reconnect after delay
                        setTimeout(async () => {
                            try {
                                // CRITICAL: Clear old provider and polling so initialize() creates a fresh connection.
                                // Without this, initialize() returns early (if (this.provider) return) and EVM never recovers.
                                if (this.pollingInterval) {
                                    clearInterval(this.pollingInterval);
                                    this.pollingInterval = null;
                                }
                                if (this.provider) {
                                    if (typeof this.provider.destroy === 'function') {
                                        await this.provider.destroy().catch(() => {});
                                    }
                                    this.provider = null;
                                }

                                await this.initialize();
                                // Re-establish factory listener
                                if (this.factoryAddress) {
                                    await this.listenToFactory(this.factoryAddress);
                                    await this.catchUpFactoryEvents();
                                }
                                await this.reconnectBondingCurveListeners();
                                console.log('✓ EVM WebSocket reconnected and listeners re-established');
                            } catch (error) {
                                console.error('Error reconnecting EVM WebSocket:', error);
                            }
                        }, 5000);
                    });
                    
                    // Handle unhandled WebSocket messages to prevent crashes
                    // The ethers.js WebSocket provider can crash when receiving messages for requests that no longer exist
                    // We need to wrap the provider's internal message handler
                    const originalOnMessage = ws.onmessage;
                    if (originalOnMessage) {
                        ws.onmessage = (event) => {
                            try {
                                originalOnMessage(event);
                            } catch (error) {
                                // Catch errors from undefined request callbacks (common WebSocket provider bug)
                                if (error.message && (error.message.includes('callback') || error.message.includes('Cannot read properties of undefined'))) {
                                    console.warn('⚠ WebSocket message received for unknown/cleared request (ignoring)');
                                    console.warn('   This is a known ethers.js WebSocket provider issue');
                                    console.warn('   Consider using HTTP provider if this happens frequently');
                                    // Don't rethrow - prevent crash
                                    return;
                                }
                                // For other errors, log but don't crash
                                console.error('⚠ WebSocket message error:', error.message);
                                console.error('   Stack:', error.stack);
                                // Don't rethrow - prevent crash
                            }
                        };
                    }
                }
                
                // Add provider-level error handling
                this.provider.on('error', (error) => {
                    console.error('⚠ Provider error:', error.message);
                    // Don't crash - try to continue
                });
            } catch (error) {
                console.error('✗ Error initializing WebSocket provider:', error.message);
                console.log('Falling back to HTTP provider...');
                // Fallback to HTTP if WebSocket fails
                if (httpRpcUrl) {
                    this.provider = new ethers.providers.JsonRpcProvider(httpRpcUrl);
                    this.isWebSocket = false;
                    console.log('✓ Event listener initialized with HTTP provider (fallback)');
                    this.startPolling();
                } else {
                    throw new Error('No RPC URL configured');
                }
            }
        } else if (httpRpcUrl) {
            this.provider = new ethers.providers.JsonRpcProvider(httpRpcUrl);
            this.isWebSocket = false;
            console.log('✓ Event listener initialized with HTTP provider (will use polling)');
            // Start polling for events since HTTP doesn't support .on()
            this.startPolling();
        } else {
            throw new Error('No RPC URL configured');
        }
        
        // For WebSocket providers, also start backup polling (every 800ms) as a safety net
        // Reduced from 2s to match EVM block times better and improve update speed vs Solana
        if (this.isWebSocket) {
            // Start a lighter backup polling for WebSocket
            if (!this.pollingInterval) {
                this.pollingInterval = setInterval(async () => {
                    try {
                        await this.pollForBondingCurveEvents();
                    } catch (error) {
                        // Silently handle - this is just a backup
                    }
                }, 800); // Poll every 800ms as backup (was 2s - EVM updates were slow)
            }
            // Block monitoring removed - regular polling already catches events efficiently
        }
    }

    /**
     * Start listening to factory contract for new token creation events
     */
    async listenToFactory(factoryAddress) {
        if (!this.provider) {
            await this.initialize();
        }

        if (this.factoryListener) {
            console.log(`Already listening to factory: ${factoryAddress}`);
            return;
        }

        try {
            this.factoryAddress = factoryAddress;
            this.factoryContract = new ethers.Contract(
                factoryAddress,
                FACTORY_ABI,
                this.provider
            );

            // Listen for TokenCreated events
            this.factoryListener = this.factoryContract.on("TokenCreated", async (
                tokenAddress,
                bondingCurveAddress,
                creator,
                name,
                symbol,
                description,
                website,
                twitter,
                telegram,
                timestamp,
                blockNumber,
                liquidityLockDuration,
                event
            ) => {
                console.log(`\n🎉 New token created!`);
                console.log(`  Token: ${tokenAddress}`);
                console.log(`  Bonding Curve: ${bondingCurveAddress}`);
                
                // Track last processed block
                const eventBlock = Number(blockNumber);
                if (!this.lastFactoryBlock || eventBlock > this.lastFactoryBlock) {
                    this.lastFactoryBlock = eventBlock;
                }
                
                await this.handleNewTokenCreated(
                    tokenAddress,
                    bondingCurveAddress,
                    creator,
                    name,
                    symbol,
                    description,
                    website,
                    twitter,
                    telegram,
                    timestamp,
                    blockNumber,
                    liquidityLockDuration,
                    event
                );
            });

            console.log(`✓ Started listening to factory contract: ${factoryAddress}`);
            
            // Initial catch-up for any missed factory events
            await this.catchUpFactoryEvents();
            
            // Set up periodic catch-up every 5 minutes
            this.startPeriodicCatchUp();
        } catch (error) {
            console.error(`Error setting up factory listener:`, error);
            throw error;
        }
    }

    /**
     * Handle new token created event
     * 1. Store token and bonding curve info to DB
     * 2. Start listening to bonding curve for trade events
     */
    async handleNewTokenCreated(
        tokenAddress,
        bondingCurveAddress,
        creator,
        name,
        symbol,
        description,
        website,
        twitter,
        telegram,
        timestamp,
        blockNumber,
        liquidityLockDuration,
        event
    ) {
        try {
            // Convert BigNumber values to numbers/strings
            const blockNumberNum = blockNumber && blockNumber.toNumber ? blockNumber.toNumber() : Number(blockNumber);
            const timestampNum = timestamp && timestamp.toNumber ? timestamp.toNumber() : Number(timestamp);
            const lockDur = liquidityLockDuration != null && liquidityLockDuration.toString
                ? liquidityLockDuration.toString()
                : (liquidityLockDuration != null ? String(liquidityLockDuration) : '');
            
            // Get block timestamp as fallback if event timestamp is invalid
            let finalTimestamp = timestampNum;
            if (!finalTimestamp || finalTimestamp === 0 || isNaN(finalTimestamp)) {
                try {
                    const eventBlockNum = event.blockNumber && event.blockNumber.toNumber ? event.blockNumber.toNumber() : Number(event.blockNumber);
                    const block = await this.provider.getBlock(eventBlockNum).catch(() => null);
                    finalTimestamp = block ? Number(block.timestamp) : Math.floor(Date.now() / 1000);
                } catch (err) {
                    finalTimestamp = Math.floor(Date.now() / 1000);
                }
            }

            // Get initial LP values from environment variables
            const virtualEthLp = virtualEthLpInitial || '10000000000000000';
            const virtualTokenLp = virtualTokenLpInitial || '1073000000000000000000000';
            const realEthLp = realEthLpInitial || '0';
            const realTokenLp = realTokenLpInitial || '200000000000000000000000000';
            
            // Calculate k = virtual_eth_lp * virtual_token_lp
            const k = (BigInt(virtualEthLp) * BigInt(virtualTokenLp)).toString();
            
            // Prepare token data to save to DB
            const tokenData = {
                tokenAddress: tokenAddress.toLowerCase(),
                bondingCurveAddress: bondingCurveAddress.toLowerCase(),
                creator: creator.toLowerCase(),
                name: String(name || ''),
                symbol: String(symbol || ''),
                description: String(description || ''),
                website: String(website || ''),
                twitter: String(twitter || ''),
                telegram: String(telegram || ''),
                discord: '',
                logoUrl: '',
                bannerUrl: '',
                totalSupply: '1000000000000000000000000000',
                decimals: 18,
                transactionHash: event.transactionHash,
                blockNumber: blockNumberNum,
                timestamp: finalTimestamp,
                initialPrice: '0',
                feeAmount: '0',
                virtualEthLp: String(virtualEthLp),
                virtualTokenLp: String(virtualTokenLp),
                realEthLp: String(realEthLp),
                realTokenLp: String(realTokenLp),
                k: String(k),
                tokenStartPrice: '0',
                volume: '0',
                lpCreated: BigInt(realEthLp) >= BigInt(bondingLimit || '0'),
                liquidityLockDurationSeconds: lockDur || undefined
            };

            // Save token and bonding curve to database
            const tokenService = require('./services/tokenService');
            const result = await tokenService.createToken(tokenData);

            if (result.isNew) {
                console.log(`  ✓ Token and bonding curve saved to database`);
                
                // Catch the initial TokenTraded event from the same transaction
                // The factory contract calls buyToken in the same transaction, so we need to query for it
                try {
                    await this.catchInitialTokenTradedEvent(
                        tokenAddress.toLowerCase(),
                        bondingCurveAddress.toLowerCase(),
                        event.transactionHash,
                        event.blockNumber
                    );
                } catch (err) {
                    console.log(`  Note: Could not catch initial TokenTraded event: ${err.message}`);
                }
                
                // Start listening to this bonding curve for trade events
                await this.listenToBondingCurve(bondingCurveAddress.toLowerCase());
            } else {
                console.log(`  ℹ Token already exists in database`);
            }
        } catch (error) {
            console.error(`Error handling new token creation:`, error);
        }
    }

    /**
     * Catch the initial TokenTraded event from the same transaction as TokenCreated
     * This happens because the factory contract calls buyToken in the same transaction
     */
    async catchInitialTokenTradedEvent(
        tokenAddress,
        bondingCurveAddress,
        transactionHash,
        blockNumber
    ) {
        try {
            // Wait a bit for the transaction to be fully confirmed and logs indexed
            await new Promise(resolve => setTimeout(resolve, 1000));
            
            // Get the transaction receipt to access all logs from the transaction
            // Retry a few times in case the receipt isn't immediately available
            let receipt = null;
            let retries = 3;
            while (retries > 0 && !receipt) {
                try {
                    receipt = await this.provider.getTransactionReceipt(transactionHash);
                    if (!receipt) {
                        retries--;
                        if (retries > 0) {
                            await new Promise(resolve => setTimeout(resolve, 500));
                        }
                    }
                } catch (err) {
                    retries--;
                    if (retries > 0) {
                        await new Promise(resolve => setTimeout(resolve, 500));
                    }
                }
            }
            
            if (!receipt || !receipt.logs || receipt.logs.length === 0) {
                console.log(`  ℹ No logs found in transaction receipt`);
                return;
            }

            // Create a contract instance to parse the logs
            const bondingCurveContract = new ethers.Contract(
                bondingCurveAddress,
                BONDING_CURVE_ABI,
                this.provider
            );

            // Find the TokenTraded event in the transaction logs
            let initialTradeEvent = null;
            
            // Get the event signature (topic[0]) for TokenTraded
            const tokenTradedEvent = bondingCurveContract.filters.TokenTraded();
            const eventTopic = tokenTradedEvent.topics ? tokenTradedEvent.topics[0] : null;
            
            console.log(`  Searching for TokenTraded event in ${receipt.logs.length} log(s)...`);
            if (eventTopic) {
                console.log(`  Event signature: ${eventTopic}`);
            }
            
            for (const log of receipt.logs) {
                // Check if this log is from the bonding curve contract
                if (log.address.toLowerCase() !== bondingCurveAddress.toLowerCase()) {
                    continue;
                }

                // Check if the first topic matches the TokenTraded event signature
                if (eventTopic && log.topics && log.topics[0] !== eventTopic) {
                    continue;
                }

                try {
                    // Try to parse this log as a TokenTraded event
                    const parsedLog = bondingCurveContract.interface.parseLog(log);
                    
                    if (parsedLog && parsedLog.name === 'TokenTraded') {
                        // Found the TokenTraded event!
                        console.log(`  ✓ Parsed TokenTraded event from log`);
                        
                        // Reconstruct the event object with all necessary properties
                        initialTradeEvent = {
                            ...parsedLog,
                            transactionHash: receipt.transactionHash,
                            blockNumber: receipt.blockNumber,
                            address: log.address,
                            args: parsedLog.args
                        };
                        break;
                    }
                } catch (parseError) {
                    // This log is not a TokenTraded event, continue
                    continue;
                }
            }

            if (initialTradeEvent) {
                console.log(`  ✓ Found initial TokenTraded event in same transaction`);
                
                // Extract event arguments (now includes tokenAmount after amount)
                const [eventTokenAddress, timestamp, openPrice, closePrice, amount, tokenAmount, trader, isBuy] = initialTradeEvent.args;
                
                // Create a proper event object for the handler
                const eventObj = {
                    transactionHash: receipt.transactionHash,
                    blockNumber: receipt.blockNumber,
                    args: initialTradeEvent.args
                };
                
                // Process the event using the same handler
                await this.handleTokenTradedEvent(
                    bondingCurveAddress,
                    eventTokenAddress,
                    timestamp,
                    openPrice,
                    closePrice,
                    amount,
                    tokenAmount,
                    trader,
                    isBuy,
                    eventObj
                );
                
                console.log(`  ✓ Initial trade data saved to database`);
            } else {
                console.log(`  ℹ No TokenTraded event found in the same transaction`);
            }
        } catch (error) {
            // Don't throw - this is optional, just log the error
            console.log(`  Note: Could not query initial TokenTraded event: ${error.message}`);
        }
    }

    /**
     * Start listening to a bonding curve contract for trade events
     */
    async listenToBondingCurve(bondingCurveAddress) {
        // Normalize address
        const normalizedAddress = bondingCurveAddress.toLowerCase();
        
        // Check if already listening
        if (this.bondingCurveListeners.has(normalizedAddress)) {
            console.log(`  Already listening to bonding curve: ${normalizedAddress}`);
            return;
        }

        if (!this.provider) {
            await this.initialize();
        }

        try {
            const bondingCurveContract = new ethers.Contract(
                normalizedAddress,
                BONDING_CURVE_ABI,
                this.provider
            );

            let listener = null;
            let traderFeeListener = null;
            
            // For WebSocket providers, use .on() for real-time events
            // For HTTP providers, we'll use polling (handled separately)
            if (this.isWebSocket) {
                // Listen for TraderFee events for reward distribution tracking
                traderFeeListener = bondingCurveContract.on("TraderFee", async (
                    trader,
                    tokenAddress,
                    tradeType,
                    platformFee,
                    creatorFee,
                    rewardFee,
                    feeAmount,
                    event
                ) => {
                    try {
                        console.log(`\n💰 TraderFee event caught (WebSocket)!`);
                        console.log(`  Token: ${tokenAddress}`);
                        console.log(`  Trader: ${trader}`);
                        console.log(`  Type: ${tradeType ? 'BUY' : 'SELL'}`);
                        console.log(`  Platform Fee: ${platformFee.toString()}`);
                        console.log(`  Creator Fee: ${creatorFee.toString()}`);
                        console.log(`  Reward Fee: ${rewardFee.toString()}`);
                        console.log(`  Total Fee: ${feeAmount.toString()}`);
                        console.log(`  TX: ${event.transactionHash}`);

                        await this.handleTraderFeeEvent(
                            normalizedAddress,
                            trader,
                            tokenAddress,
                            tradeType,
                            platformFee,
                            creatorFee,
                            rewardFee,
                            feeAmount,
                            event
                        );
                    } catch (error) {
                        console.error(`  ✗ Error processing TraderFee event:`, error);
                        // Don't rethrow - continue listening even if one event fails
                    }
                });
                
                console.log(`  ✓ TraderFee listener attached for ${normalizedAddress}`);
                
                // Listen for TokenTraded events with proper error handling
                // Event signature: tokenAddress, timestamp, openPrice, closePrice, amount, tokenAmount, trader, isBuy
                listener = bondingCurveContract.on("TokenTraded", async (
                    tokenAddress,
                    timestamp,
                    openPrice,
                    closePrice,
                    amount,
                    tokenAmount,
                    trader,
                    isBuy,
                    event
                ) => {
                    try {
                        console.log(`\n📊 TokenTraded event caught (WebSocket)!`);
                        console.log(`  Bonding Curve: ${normalizedAddress}`);
                        console.log(`  Token: ${tokenAddress}`);
                        console.log(`  Trader: ${trader}`);
                        console.log(`  Type: ${isBuy ? 'BUY' : 'SELL'}`);
                        console.log(`  ETH Amount: ${amount.toString()}`);
                        console.log(`  Token Amount: ${tokenAmount.toString()}`);
                        console.log(`  Price: ${closePrice.toString()}`);
                        console.log(`  TX: ${event.transactionHash}`);
                        
                        await this.handleTokenTradedEvent(
                            normalizedAddress,
                            tokenAddress,
                            timestamp,
                            openPrice,
                            closePrice,
                            amount,
                            tokenAmount,
                            trader,
                            isBuy,
                            event
                        );
                    } catch (error) {
                        console.error(`  ✗ Error processing TokenTraded event:`, error);
                        // Don't rethrow - continue listening even if one event fails
                    }
                });
                
                console.log(`  ✓ WebSocket listener attached for ${normalizedAddress}`);
                
                // Also set up a backup polling mechanism for WebSocket (in case WebSocket fails)
                // This ensures we catch events even if WebSocket has issues
                console.log(`  ✓ Backup polling enabled for WebSocket provider`);
            } else {
                // For HTTP providers, .on() doesn't work, so we'll use polling
                console.log(`  Note: Using polling for HTTP provider (WebSocket recommended for real-time events)`);
            }
            
            // ALWAYS enable polling as a backup, even for WebSocket providers
            // This ensures we catch events even if WebSocket fails or has issues
            if (!this.pollingInterval && !this.isWebSocket) {
                // Polling will be started in initialize() for HTTP providers
                // For WebSocket, we'll start a lighter backup polling
            }

            // Get initial block number for this bonding curve
            const currentBlock = await this.provider.getBlockNumber();
            this.lastBondingCurveBlocks.set(normalizedAddress, currentBlock);

            this.bondingCurveListeners.set(normalizedAddress, {
                contract: bondingCurveContract,
                listener: listener,
                lastBlock: currentBlock
            });

            console.log(`  ✓ Started listening to bonding curve: ${normalizedAddress}`);
            console.log(`    Provider type: ${this.isWebSocket ? 'WebSocket' : 'HTTP'}`);
            console.log(`    Listener active: ${listener ? 'Yes' : 'No (using polling only)'}`);
            console.log(`    Current block: ${currentBlock}`);
            
            // Immediately catch up on any missed events from this bonding curve
            // This ensures we don't miss events that happened before the listener started
            try {
                console.log(`  Catching up on missed events for ${normalizedAddress}...`);
                await this.catchUpBondingCurveEvents(normalizedAddress);
            } catch (catchUpError) {
                console.error(`  ⚠ Error catching up events for ${normalizedAddress}:`, catchUpError.message);
                // Don't fail the listener setup if catch-up fails
            }
            
            // Also do an immediate poll to catch any events that just happened
            try {
                console.log(`  Running immediate event check...`);
                await this.pollForBondingCurveEvents();
            } catch (pollError) {
                console.error(`  ⚠ Error in immediate poll:`, pollError.message);
            }
        } catch (error) {
            console.error(`✗ Error setting up bonding curve listener for ${normalizedAddress}:`, error);
            throw error; // Re-throw so caller knows it failed
        }
    }

    /**
     * Handle TraderFee event from bonding curve (for reward distribution tracking)
     * Event parameters: trader, tokenAddress, tradeType, platformFee, creatorFee, rewardFee, feeAmount
     */
    async handleTraderFeeEvent(
        bondingCurveAddress,
        trader,
        tokenAddress,
        tradeType,
        platformFee,
        creatorFee,
        rewardFee,
        feeAmount,
        event
    ) {
        try {
            const toAddr = (v) => (v && typeof v === 'string' ? v : (v && typeof v.toString === 'function' ? v.toString() : String(v || ''))).toLowerCase();
            const tokenAddressLower = toAddr(tokenAddress);
            const traderLower = toAddr(trader);
            const eventBlockNumber = event.blockNumber && event.blockNumber.toNumber ? event.blockNumber.toNumber() : Number(event.blockNumber);

            // Get block timestamp
            let blockTime = Math.floor(Date.now() / 1000);
            try {
                const block = await this.provider.getBlock(eventBlockNumber);
                if (block && block.timestamp) {
                    blockTime = block.timestamp;
                }
            } catch (err) {
                // Use current time as fallback
            }

            // Insert trader fee for reward distribution
            try {
                await supabaseService.insertTraderFee({
                    walletAddress: traderLower,
                    mint: tokenAddressLower,
                    chain: getEvmChainSlug(),
                    tradeType: tradeType,
                    platformFee: platformFee.toString(),
                    creatorFee: creatorFee.toString(),
                    rewardFee: rewardFee ? rewardFee.toString() : '0',
                    feeAmount: feeAmount.toString(),
                    transactionHash: event.transactionHash.toLowerCase(),
                    slot: eventBlockNumber,
                    blockTime: blockTime
                });
                
                // Accumulate creator fee for this token (for creator distribution at round end)
                if (creatorFee && BigInt(creatorFee.toString()) > 0n) {
                    try {
                        await supabaseService.incrementTokenCreatorFee(tokenAddressLower, getEvmChainSlug(), creatorFee.toString());
                    } catch (incErr) {
                        console.error('  ⚠ Failed to increment token creator fee:', incErr.message);
                    }
                }
                
                console.log(`  ✓ EVM TraderFee processed: ${traderLower} fee=${feeAmount.toString()} (${tradeType ? 'buy' : 'sell'})`);
            } catch (insertError) {
                // Handle duplicate key errors gracefully
                if (insertError.message && (
                    insertError.message.includes('duplicate key') ||
                    insertError.message.includes('unique constraint') ||
                    insertError.code === '23505' ||
                    insertError.code === 'PGRST204'
                )) {
                    console.log(`  ℹ TraderFee ${event.transactionHash} already stored, skipping`);
                } else {
                    throw insertError;
                }
            }
        } catch (error) {
            console.error(`  ✗ Error handling TraderFee event:`, error);
            console.error(`    Bonding Curve: ${bondingCurveAddress}`);
            console.error(`    Transaction: ${event?.transactionHash || 'unknown'}`);
            // Don't rethrow - we want to continue processing other events
        }
    }

    /**
     * Handle token trade event from bonding curve
     * Event parameters: tokenAddress, timestamp, openPrice, closePrice, amount, tokenAmount, trader, isBuy
     */
    async handleTokenTradedEvent(
        bondingCurveAddress,
        tokenAddress,
        timestamp,
        openPrice,
        closePrice,
        amount,
        tokenAmount,
        trader,
        isBuy,
        event
    ) {
        try {
            // Token address and trader may be Ethers objects; convert to string safely
            const toAddr = (v) => (v && typeof v === 'string' ? v : (v && typeof v.toString === 'function' ? v.toString() : String(v || ''))).toLowerCase();
            const tokenAddressLower = toAddr(tokenAddress);

            // Convert BigNumber values to numbers
            const eventBlockNumber = event.blockNumber && event.blockNumber.toNumber ? event.blockNumber.toNumber() : Number(event.blockNumber);
            const timestampNum = timestamp && timestamp.toNumber ? timestamp.toNumber() : Number(timestamp);

            // Save price data to database (using upsert to prevent duplicates)
            const priceData = {
                tokenAddress: tokenAddressLower,
                timestamp: timestampNum,
                openPrice: openPrice.toString(),
                closePrice: closePrice.toString(),
                amount: amount.toString(),
                trader: toAddr(trader),
                isBuy,
                transactionHash: (typeof event.transactionHash === 'string' ? event.transactionHash.toLowerCase() : event.transactionHash),
                blockNumber: eventBlockNumber,
                chain: getEvmChainSlug()
            };

            // Try to insert price data (returns null if duplicate)
            const insertedPriceData = await supabaseService.addTokenPriceData(priceData);
            
            // If price data already exists, skip processing
            if (!insertedPriceData) {
                console.log(`  ℹ Trade event already processed: ${event.transactionHash}`);
                return; // Already processed
            }

            // Save trade history (now includes actual tokenAmount from event)
            const tradeData = {
                tokenAddress: tokenAddressLower,
                bondingCurveAddress: bondingCurveAddress.toLowerCase(),
                trader: toAddr(trader),
                isBuy,
                ethAmount: amount.toString(),
                tokenAmount: tokenAmount ? tokenAmount.toString() : '0',
                price: closePrice.toString(),
                transactionHash: (typeof event.transactionHash === 'string' ? event.transactionHash.toLowerCase() : event.transactionHash),
                blockNumber: eventBlockNumber,
                timestamp: timestampNum,
                chain: getEvmChainSlug()
            };

            try {
                await supabaseService.addTradeHistory(tradeData);
            } catch (err) {
                // Trade history might already exist, continue
            }

            // Update bonding curve statistics and LP values
            try {
                const tokenService = require('./services/tokenService');
                const bondingCurve = await tokenService.getBondingCurveByAddress(bondingCurveAddress);

                if (!bondingCurve) {
                    console.error(`✗ Bonding curve not found: ${bondingCurveAddress}`);
                    return;
                }

                // Read authoritative reserves/price/k/volume directly from the contract so DB values
                // self-heal: a missed or duplicated TokenTraded event no longer skews every later
                // value (the old code accumulated deltas off the previous DB row). Falls back to the
                // legacy delta math only if the on-chain read fails.
                const onChain = await this.readBondingCurveStateOnChain(bondingCurveAddress, eventBlockNumber);

                // Counts are backend-only (not exposed on-chain); increment once per tx. Safe because
                // the price-data dedup above guarantees this block runs at most once per transaction.
                const updateData = {
                    totalTrades: (bondingCurve.totalTrades || 0) + 1
                };
                if (isBuy) {
                    updateData.totalBuyers = (bondingCurve.totalBuyers || 0) + 1;
                } else {
                    updateData.totalSellers = (bondingCurve.totalSellers || 0) + 1;
                }

                if (onChain) {
                    // Absolute on-chain truth — idempotent and self-correcting.
                    updateData.virtualEthLp = onChain.virtualEthLp;
                    updateData.virtualTokenLp = onChain.virtualTokenLp;
                    updateData.realEthLp = onChain.realEthLp;
                    updateData.realTokenLp = onChain.realTokenLp;
                    updateData.k = onChain.k;
                    updateData.currentPrice = (onChain.currentPrice && onChain.currentPrice !== '0')
                        ? onChain.currentPrice
                        : closePrice.toString();
                    updateData.volume = onChain.volume;
                    updateData.lpCreated = onChain.lpCreated || BigInt(onChain.realEthLp) >= BigInt(bondingLimit || '0');
                } else {
                    // Fallback: derive from previous DB values + this trade's deltas (legacy behaviour).
                    console.warn(`  ⚠ On-chain read failed for ${bondingCurveAddress}; using delta fallback`);
                    const currentVirtualEthLp = (bondingCurve.virtualEthLp && BigInt(bondingCurve.virtualEthLp) > 0n)
                        ? bondingCurve.virtualEthLp
                        : virtualEthLpInitial || '10000000000000000';
                    const currentVirtualTokenLp = (bondingCurve.virtualTokenLp && BigInt(bondingCurve.virtualTokenLp) > 0n)
                        ? bondingCurve.virtualTokenLp
                        : virtualTokenLpInitial || '1073000000000000000000000';
                    const currentRealEthLp = bondingCurve.realEthLp || '0';
                    const currentRealTokenLp = bondingCurve.realTokenLp || realTokenLpInitial || '200000000000000000000000000';

                    const virtualEthLpBig = BigInt(currentVirtualEthLp);
                    const virtualTokenLpBig = BigInt(currentVirtualTokenLp);
                    const realEthLpBig = BigInt(currentRealEthLp);
                    const ethAmountBig = BigInt(amount.toString());
                    const tokenAmountBig = BigInt(tokenAmount?.toString() || '0');

                    let newVirtualEthLp, newVirtualTokenLp, newRealEthLp;
                    if (isBuy) {
                        newVirtualEthLp = (virtualEthLpBig + ethAmountBig).toString();
                        newVirtualTokenLp = virtualTokenLpBig >= tokenAmountBig
                            ? (virtualTokenLpBig - tokenAmountBig).toString()
                            : currentVirtualTokenLp; // Preserve current value to prevent data corruption
                        newRealEthLp = (realEthLpBig + ethAmountBig).toString();
                    } else {
                        newVirtualEthLp = virtualEthLpBig >= ethAmountBig
                            ? (virtualEthLpBig - ethAmountBig).toString()
                            : '0';
                        newVirtualTokenLp = (virtualTokenLpBig + tokenAmountBig).toString();
                        newRealEthLp = realEthLpBig >= ethAmountBig
                            ? (realEthLpBig - ethAmountBig).toString()
                            : '0';
                    }

                    const newVirtualEthLpBig = BigInt(newVirtualEthLp);
                    const newVirtualTokenLpBig = BigInt(newVirtualTokenLp);
                    const newK = (newVirtualEthLpBig > 0n && newVirtualTokenLpBig > 0n)
                        ? (newVirtualEthLpBig * newVirtualTokenLpBig).toString()
                        : '0';

                    updateData.currentPrice = closePrice.toString();
                    updateData.volume = (BigInt(bondingCurve.volume || '0') + ethAmountBig).toString();
                    updateData.virtualEthLp = newVirtualEthLp;
                    updateData.virtualTokenLp = newVirtualTokenLp;
                    updateData.realEthLp = newRealEthLp;
                    updateData.realTokenLp = currentRealTokenLp;
                    updateData.k = newK;
                    updateData.lpCreated = BigInt(newRealEthLp) >= BigInt(bondingLimit || '0');
                }

                await tokenService.updateBondingCurve(bondingCurveAddress, updateData);

                if (updateData.lpCreated && !bondingCurve.lpCreated) {
                    console.log(`🎉 LP Created! real_eth_lp (${updateData.realEthLp}) >= bondingLimit (${bondingLimit || '0'})`);
                }
            } catch (err) {
                console.error(`✗ Error updating bonding curve:`, err.message);
            }

            // Refresh the trader's on-chain holder balance (fire-and-forget; cron does full sync).
            try {
                require('./services/holderService')
                    .refreshEvmAddresses(tokenAddressLower, bondingCurveAddress, getEvmChainSlug(), [toAddr(trader)])
                    .catch(() => {});
            } catch (e) { /* ignore */ }

            console.log(`  ✓ Trade processed and saved: ${isBuy ? 'BUY' : 'SELL'} ${amount.toString()} ETH, ${tokenAmount ? tokenAmount.toString() : '0'} tokens @ ${closePrice.toString()}`);
        } catch (error) {
            console.error(`  ✗ Error handling trade event:`, error);
            console.error(`    Bonding Curve: ${bondingCurveAddress}`);
            console.error(`    Transaction: ${event?.transactionHash || 'unknown'}`);
            // Don't rethrow - we want to continue processing other events
        }
    }

    /**
     * Read authoritative bonding-curve state directly from the contract.
     * Used to make DB reserves/price/k/volume self-healing instead of accumulating trade deltas
     * (a single missed or duplicated TokenTraded event would otherwise skew every later value).
     * Reads at `blockTag` (the trade's block) when the node serves that state, otherwise falls
     * back to latest. Returns null if all reads fail (caller then uses the delta fallback).
     * @param {string} bondingCurveAddress
     * @param {number} [blockTag] block to read state at (point-in-time accuracy; needs the node
     *   to retain that state — recent blocks on most public RPCs, all blocks on archive nodes)
     * @returns {Promise<{virtualEthLp,virtualTokenLp,realEthLp,realTokenLp,k,currentPrice,volume,lpCreated}|null>}
     */
    async readBondingCurveStateOnChain(bondingCurveAddress, blockTag) {
        if (!this.provider) {
            return null;
        }
        const normalized = bondingCurveAddress.toLowerCase();
        const contract = this.bondingCurveListeners.get(normalized)?.contract
            || new ethers.Contract(normalized, BONDING_CURVE_ABI, this.provider);

        const readAll = async (overrides) => {
            const [virtualEthLp, virtualTokenLp, realEthLp, realTokenLp, k, currentPrice, volume, lpCreated] = await Promise.all([
                contract.virtualEthLp(overrides),
                contract.virtualTokenLp(overrides),
                contract.realEthLp(overrides),
                contract.realTokenLp(overrides),
                contract.k(overrides),
                contract.currentTokenPrice(overrides),
                contract.volume(overrides),
                contract.lpCreated(overrides)
            ]);
            return {
                virtualEthLp: virtualEthLp.toString(),
                virtualTokenLp: virtualTokenLp.toString(),
                realEthLp: realEthLp.toString(),
                realTokenLp: realTokenLp.toString(),
                k: k.toString(),
                currentPrice: currentPrice.toString(),
                volume: volume.toString(),
                lpCreated: Boolean(lpCreated)
            };
        };

        // Try at the trade's block first (point-in-time accurate); fall back to latest if the node
        // can't serve that historical state (no archive), then give up so the caller can fall back.
        const bn = Number(blockTag);
        if (Number.isFinite(bn) && bn > 0) {
            try {
                return await readAll({ blockTag: bn });
            } catch (err) {
                // Historical state unavailable — fall through to latest.
            }
        }
        try {
            return await readAll({});
        } catch (err) {
            console.error(`  ⚠ Failed to read on-chain bonding curve state for ${normalized}: ${err.message}`);
            return null;
        }
    }

    /**
     * Catch up on missed TokenCreated events from factory
     */
    async catchUpFactoryEvents() {
        if (!this.factoryAddress || !this.factoryContract) {
            return;
        }

        try {
            const latestBlock = await this.provider.getBlockNumber();

            // Find last processed token creation from database
            const tokenService = require('./services/tokenService');
            const tokens = await tokenService.getAllTokens({ limit: 1, sortBy: 'blockNumber', sortOrder: -1 });
            const lastDbBlock = tokens && tokens.tokens && tokens.tokens.length > 0
                ? Number(tokens.tokens[0].blockNumber)
                : 0;

            // Highest block we've already processed (DB or in-memory)
            const lastProcessed = Math.max(lastDbBlock, this.lastFactoryBlock || 0);

            // Never scan before the factory deploy block. Without this, a fresh/empty DB
            // would scan from block 1 across the entire chain (millions of queryFilter calls).
            const startBlock = Math.max(lastProcessed + 1, factoryDeployBlock || 0);

            if (startBlock > latestBlock) {
                return; // Already up to date
            }

            if (!factoryDeployBlock && lastProcessed === 0) {
                console.warn('⚠ FACTORY_DEPLOY_BLOCK not set and DB is empty — factory catch-up will scan from block 1. Set FACTORY_DEPLOY_BLOCK in .env to the factory deploy block to avoid this.');
            }

            console.log(`Catching up factory events from block ${startBlock} to ${latestBlock}...`);
            
            const batchSize = 100;
            let totalEvents = 0;
            
            for (let i = startBlock; i <= latestBlock; i += batchSize) {
                const endBlock = Math.min(i + batchSize - 1, latestBlock);
                
                try {
                    const events = await this.factoryContract.queryFilter(
                        this.factoryContract.filters.TokenCreated(),
                        i,
                        endBlock
                    );
                    
                    if (events.length > 0) {
                        console.log(`  Found ${events.length} missed TokenCreated event(s) in blocks ${i}-${endBlock}`);
                    }
                    
                    for (const event of events) {
                        const [tokenAddress, bondingCurveAddress, creator, name, symbol, description, website, twitter, telegram, timestamp, blockNumber, liquidityLockDuration] = event.args;
                        
                        // Convert BigNumber to number
                        const blockNumberNum = blockNumber && blockNumber.toNumber ? blockNumber.toNumber() : Number(blockNumber);
                        const timestampNum = timestamp && timestamp.toNumber ? timestamp.toNumber() : Number(timestamp);
                        
                        // Check if already processed
                        const existingToken = await tokenService.getTokenByAddress(tokenAddress);
                        if (!existingToken) {
                            await this.handleNewTokenCreated(
                                tokenAddress,
                                bondingCurveAddress,
                                creator,
                                name,
                                symbol,
                                description,
                                website,
                                twitter,
                                telegram,
                                timestampNum,
                                blockNumberNum,
                                liquidityLockDuration,
                                event
                            );
                            totalEvents++;
                        }
                        
                        // Update last processed block
                        if (!this.lastFactoryBlock || blockNumberNum > this.lastFactoryBlock) {
                            this.lastFactoryBlock = blockNumberNum;
                        }
                    }
                    
                    await new Promise(resolve => setTimeout(resolve, 100)); // Small delay between batches
                } catch (error) {
                    console.error(`  Error processing blocks ${i}-${endBlock}:`, error.message);
                }
            }
            
            if (totalEvents > 0) {
                console.log(`✓ Caught up ${totalEvents} missed factory event(s)`);
            }
        } catch (error) {
            console.error('Error catching up factory events:', error.message);
        }
    }

    /**
     * Catch up on missed TokenTraded events for a bonding curve
     */
    async catchUpBondingCurveEvents(bondingCurveAddress) {
        try {
            // Normalize address
            const normalizedAddress = bondingCurveAddress.toLowerCase();
            
            // Get contract from listeners map, or create a temporary one if not found
            let contract = this.bondingCurveListeners.get(normalizedAddress)?.contract;
            if (!contract) {
                // Create a temporary contract instance for catch-up
                contract = new ethers.Contract(
                    normalizedAddress,
                    BONDING_CURVE_ABI,
                    this.provider
                );
            }

            const latestBlock = await this.provider.getBlockNumber();
            
            // Get token address from bonding curve
            const tokenService = require('./services/tokenService');
            const bondingCurve = await tokenService.getBondingCurveByAddress(bondingCurveAddress);
            
            if (!bondingCurve || !bondingCurve.tokenAddress) {
                console.error(`  ⚠ Bonding curve not found or missing token address: ${normalizedAddress}`);
                // Still try to catch up from a reasonable starting point
                const startBlock = Math.max(latestBlock - 1000, 0); // Last 1000 blocks as fallback
                if (startBlock < latestBlock) {
                    return await this.processCatchUpBlocks(contract, normalizedAddress, startBlock, latestBlock);
                }
                return;
            }
            
            // Find last processed trade event by checking the highest block_number in price_data
            // We need to query by block_number, not timestamp, to get the actual latest block
            const priceData = await supabaseService.getTokenPriceData(bondingCurve.tokenAddress, 100);
            
            // Find the highest block_number from the price data
            let lastBlock = null;
            if (priceData && priceData.length > 0) {
                // Sort by block_number descending to get the latest
                const sortedByBlock = priceData.sort((a, b) => (b.blockNumber || 0) - (a.blockNumber || 0));
                lastBlock = sortedByBlock[0]?.blockNumber || null;
                console.log(`  Last processed block from DB: ${lastBlock} (found ${priceData.length} price data records)`);
            }
            
            // Also check the lastBondingCurveBlocks map as a fallback
            const mapLastBlock = this.lastBondingCurveBlocks.get(normalizedAddress);
            if (mapLastBlock && (!lastBlock || mapLastBlock > lastBlock)) {
                console.log(`  Last processed block from map: ${mapLastBlock}`);
                lastBlock = mapLastBlock;
            }
            
            // Determine start block for catch-up
            let startBlock;
            if (!lastBlock) {
                // No previous data, start from bonding curve creation or last 1000 blocks
                startBlock = bondingCurve.blockNumber || Math.max(latestBlock - 1000, 0);
                console.log(`  No previous data found, starting from block ${startBlock}`);
            } else {
                // Start from the block after the last processed one
                // But also check a few blocks back to ensure we didn't miss anything
                startBlock = Math.max(lastBlock - 5, bondingCurve.blockNumber || 0);
                console.log(`  Starting catch-up from block ${startBlock} (last processed: ${lastBlock})`);
            }
            
            if (startBlock >= latestBlock) {
                console.log(`  ℹ No catch-up needed for ${normalizedAddress} (already up to date: ${startBlock} >= ${latestBlock})`);
                return; // Already up to date
            }
            
            console.log(`  🔍 Catching up from block ${startBlock} to ${latestBlock} (${latestBlock - startBlock + 1} blocks)...`);
            const result = await this.processCatchUpBlocks(contract, normalizedAddress, startBlock, latestBlock);
            console.log(`  ✓ Catch-up completed for ${normalizedAddress}`);
            return result;
        } catch (error) {
            console.error(`  ✗ Error catching up bonding curve events for ${bondingCurveAddress}:`, error.message);
            throw error; // Re-throw so caller knows it failed
        }
    }

    /**
     * Process catch-up blocks for bonding curve (TokenTraded + TraderFee)
     */
    async processCatchUpBlocks(contract, bondingCurveAddress, startBlock, latestBlock) {
        const batchSize = 100;
        let totalEvents = 0;
        let totalTraderFees = 0;
        const totalBlocks = latestBlock - startBlock + 1;
        
        console.log(`  Processing ${totalBlocks} block(s) in batches of ${batchSize}...`);
        
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
                    console.log(`    📊 Found ${events.length} TokenTraded and ${traderFeeEvents.length} TraderFee event(s) in blocks ${i}-${endBlock}`);
                } else if ((i - startBlock) % (batchSize * 5) === 0) {
                    console.log(`    Checking blocks ${i}-${endBlock}... (no events found)`);
                }
                
                for (const event of events) {
                    const txHash = typeof event.transactionHash === 'string' ? event.transactionHash.toLowerCase() : event.transactionHash;
                    if (await supabaseService.checkPriceDataExists(txHash, getEvmChainSlug())) continue;
                    const [tokenAddress, timestamp, openPrice, closePrice, amount, tokenAmount, trader, isBuy] = event.args;
                    await this.handleTokenTradedEvent(
                        bondingCurveAddress,
                        tokenAddress,
                        timestamp,
                        openPrice,
                        closePrice,
                        amount,
                        tokenAmount,
                        trader,
                        isBuy,
                        event
                    );
                    totalEvents++;
                }
                
                for (const event of traderFeeEvents) {
                    const txHash = typeof event.transactionHash === 'string' ? event.transactionHash.toLowerCase() : event.transactionHash;
                    if (await supabaseService.checkTraderFeeExists(txHash, getEvmChainSlug())) continue;
                    const [trader, tokenAddress, tradeType, platformFee, creatorFee, rewardFee, feeAmount] = event.args;
                    await this.handleTraderFeeEvent(
                        bondingCurveAddress,
                        trader,
                        tokenAddress,
                        tradeType,
                        platformFee,
                        creatorFee,
                        rewardFee,
                        feeAmount,
                        event
                    );
                    totalTraderFees++;
                }
                
                await new Promise(resolve => setTimeout(resolve, 100)); // Small delay between batches
            } catch (error) {
                console.error(`  ✗ Error processing blocks ${i}-${endBlock}:`, error.message);
            }
        }
        
        if (totalEvents > 0 || totalTraderFees > 0) {
            console.log(`  ✓ Caught up ${totalEvents} trade(s) and ${totalTraderFees} TraderFee(s) for ${bondingCurveAddress}`);
        } else {
            console.log(`  ℹ No missed events found for ${bondingCurveAddress}`);
        }
        
        return totalEvents;
    }

    /**
     * Reconnect all bonding curve listeners after WebSocket reconnection
     */
    async reconnectBondingCurveListeners() {
        try {
            const tokenService = require('./services/tokenService');
            // Only EVM bonding curves — Solana has its own event listener
            const activeBondingCurves = await supabaseService.getActiveBondingCurves(getEvmChainSlug());
            
            console.log(`Reconnecting ${activeBondingCurves.length} bonding curve listener(s)...`);
            
            for (const bc of activeBondingCurves) {
                const address = bc.bondingCurveAddress?.toLowerCase();
                if (!address) continue;
                
                try {
                    // Re-establish listener
                    await this.listenToBondingCurve(address);
                    // Catch up on missed events
                    await this.catchUpBondingCurveEvents(address);
                } catch (error) {
                    console.error(`  Error reconnecting ${address}:`, error.message);
                }
            }
        } catch (error) {
            console.error('Error reconnecting bonding curve listeners:', error);
        }
    }

    /**
     * Force recycle EVM provider and listeners (e.g. when WebSocket dies silently or polling stalls).
     * Clears provider, reinitializes, and reconnects all bonding curve listeners.
     */
    async forceRecycleEVM(reason = 'stale') {
        if (this.isRecycling) {
            return; // Already recycling
        }
        this.isRecycling = true;
        console.log(`[EVM] Force recycling (reason: ${reason})...`);
        // Clear the polling guard: a poll mid-flight against the old (now-destroyed) provider
        // will reject and run its finally, but reset here too so the fresh interval is never blocked.
        this.isPolling = false;
        try {
            if (this.pollingInterval) {
                clearInterval(this.pollingInterval);
                this.pollingInterval = null;
            }
            if (this.provider) {
                if (typeof this.provider.destroy === 'function') {
                    await this.provider.destroy().catch(() => {});
                }
                this.provider = null;
            }
            this.factoryListener = null;
            this.factoryContract = null;
            for (const [address, data] of this.bondingCurveListeners) {
                if (data.listener) {
                    try {
                        data.contract.removeAllListeners('TokenTraded');
                        data.contract.removeAllListeners('TraderFee');
                    } catch (err) { /* ignore */ }
                }
            }
            this.bondingCurveListeners.clear();
            this.lastBondingCurveBlocks.clear();
            this.consecutivePollFailures = 0;

            await this.initialize();
            if (this.factoryAddress) {
                await this.listenToFactory(this.factoryAddress);
                await this.catchUpFactoryEvents();
            }
            await this.reconnectBondingCurveListeners();
            console.log('[EVM] ✓ Recycled successfully');
        } catch (error) {
            console.error('[EVM] Recycle failed:', error.message);
            this.isRecycling = false;
            // Retry recycle after 10s
            setTimeout(() => {
                this.isRecycling = false;
                this.forceRecycleEVM('retry-after-failure').catch(() => {});
            }, 10000);
            return;
        }
        this.isRecycling = false;
    }

    /**
     * Start polling for events when using HTTP provider
     * (WebSocket providers use .on() for real-time events)
     */
    startPolling() {
        // Clear any existing polling interval
        if (this.pollingInterval) {
            clearInterval(this.pollingInterval);
        }
        
        // Poll every 800ms for new events (faster to catch events, closer to Solana speed)
        this.pollingInterval = setInterval(async () => {
            try {
                await this.pollForBondingCurveEvents();
            } catch (error) {
                console.error('Error polling for events:', error.message);
            }
        }, 800); // Poll every 800ms (was 1s - EVM updates were slower than Solana)
        
        // Note: Block monitoring removed - regular polling already catches new events efficiently
        // This saves RPC calls (getBlockNumber every 2s was redundant)
        
        console.log('  ✓ Polling started (every 800ms) for HTTP provider');
    }


    /**
     * Poll for new TokenTraded and TraderFee events from all active bonding curves.
     * Queries in batches from lastBlock+1 to latestBlock to avoid missing events when behind.
     */
    async pollForBondingCurveEvents() {
        if (this.isRecycling || !this.provider || this.bondingCurveListeners.size === 0) {
            return; // Recycle in progress, no provider, or no bonding curves to poll
        }
        if (this.isPolling) {
            // A previous poll is still running. setInterval does not await the callback, so
            // overlapping runs would race the per-curve lastBlock cursor and multiply RPC
            // load (more 429s → more missed events). Skip; the cursor is preserved for next tick.
            return;
        }
        this.isPolling = true;

        try {
            const latestBlock = await this.provider.getBlockNumber();
            // Do NOT reset consecutivePollFailures here. getBlockNumber() succeeding while
            // eth_getLogs fails must still count as a failed cycle, otherwise the recycle
            // safety-net never fires while trade events are silently missed.
            let cycleHadFailure = false;
            // RPC providers often limit eth_getLogs range (e.g. 1000–2000 blocks)
            const pollBatchSize = 200;

            for (const [address, data] of this.bondingCurveListeners) {
                try {
                    // Clamp lastBlock to latestBlock to avoid fromBlock > toBlock (reorg/race)
                    let lastBlock = data.lastBlock ?? Math.max(latestBlock - 5, 0);
                    if (lastBlock > latestBlock) {
                        lastBlock = Math.max(0, latestBlock - 10);
                        if (data) data.lastBlock = lastBlock;
                    }
                    let startBlock = lastBlock + 1;

                    if (startBlock > latestBlock) {
                        continue; // Already up to date
                    }

                    // Query from startBlock to latestBlock in batches so we never skip blocks
                    for (let fromBlock = startBlock; fromBlock <= latestBlock; fromBlock += pollBatchSize) {
                        const toBlock = Math.min(fromBlock + pollBatchSize - 1, latestBlock);
                        if (fromBlock > toBlock) continue; // Guard against invalid range (race/reorg)

                        const events = await data.contract.queryFilter(
                            data.contract.filters.TokenTraded(),
                            fromBlock,
                            toBlock
                        );
                        const traderFeeEvents = await data.contract.queryFilter(
                            data.contract.filters.TraderFee(),
                            fromBlock,
                            toBlock
                        );

                        let maxProcessedBlock = lastBlock;
                        let minFailedBlock = null; // earliest block whose handler threw this batch
                        if (events.length > 0 || traderFeeEvents.length > 0) {
                            console.log(`\n📊 Found ${events.length} TokenTraded and ${traderFeeEvents.length} TraderFee event(s) for ${address} (blocks ${fromBlock}-${toBlock})`);
                        }

                        events.sort((a, b) => a.blockNumber - b.blockNumber);
                        for (const event of events) {
                            try {
                                const txHash = typeof event.transactionHash === 'string' ? event.transactionHash.toLowerCase() : event.transactionHash;
                                if (await supabaseService.checkPriceDataExists(txHash, getEvmChainSlug())) {
                                    const ebSkip = typeof event.blockNumber === 'number' ? event.blockNumber : Number(event.blockNumber);
                                    if (ebSkip > maxProcessedBlock) maxProcessedBlock = ebSkip;
                                    continue;
                                }
                                const [tokenAddress, timestamp, openPrice, closePrice, amount, tokenAmount, trader, isBuy] = event.args;
                                await this.handleTokenTradedEvent(
                                    address,
                                    tokenAddress,
                                    timestamp,
                                    openPrice,
                                    closePrice,
                                    amount,
                                    tokenAmount,
                                    trader,
                                    isBuy,
                                    event
                                );
                                const eb = typeof event.blockNumber === 'number' ? event.blockNumber : Number(event.blockNumber);
                                if (eb > maxProcessedBlock) maxProcessedBlock = eb;
                            } catch (error) {
                                console.error(`  ✗ Error processing TokenTraded:`, error.message, `TX: ${event.transactionHash}`);
                                const fb = typeof event.blockNumber === 'number' ? event.blockNumber : Number(event.blockNumber);
                                if (Number.isFinite(fb)) minFailedBlock = minFailedBlock == null ? fb : Math.min(minFailedBlock, fb);
                            }
                        }

                        for (const event of traderFeeEvents) {
                            try {
                                const txHash = typeof event.transactionHash === 'string' ? event.transactionHash.toLowerCase() : event.transactionHash;
                                if (await supabaseService.checkTraderFeeExists(txHash, getEvmChainSlug())) {
                                    const ebSkip = typeof event.blockNumber === 'number' ? event.blockNumber : Number(event.blockNumber);
                                    if (ebSkip > maxProcessedBlock) maxProcessedBlock = ebSkip;
                                    continue;
                                }
                                const [trader, tokenAddress, tradeType, platformFee, creatorFee, rewardFee, feeAmount] = event.args;
                                await this.handleTraderFeeEvent(
                                    address,
                                    trader,
                                    tokenAddress,
                                    tradeType,
                                    platformFee,
                                    creatorFee,
                                    rewardFee,
                                    feeAmount,
                                    event
                                );
                                const eb = typeof event.blockNumber === 'number' ? event.blockNumber : Number(event.blockNumber);
                                if (eb > maxProcessedBlock) maxProcessedBlock = eb;
                            } catch (error) {
                                console.error(`  ✗ Error processing TraderFee:`, error.message, `TX: ${event.transactionHash}`);
                                const fb = typeof event.blockNumber === 'number' ? event.blockNumber : Number(event.blockNumber);
                                if (Number.isFinite(fb)) minFailedBlock = minFailedBlock == null ? fb : Math.min(minFailedBlock, fb);
                            }
                        }

                        // Decide how far to advance the cursor for this curve.
                        const endBlock = toBlock;
                        const updatedData = this.bondingCurveListeners.get(address);
                        let newLastBlock = Math.max(maxProcessedBlock, endBlock);
                        let holdForRetry = false;

                        if (minFailedBlock != null) {
                            // A handler (not the RPC query) failed for an event in this batch.
                            // Hold the cursor just before the failed block so the next poll
                            // retries it instead of advancing past it — advancing would leave a
                            // permanent gap once a later trade is stored (periodic catch-up starts
                            // from the latest stored trade). Bounded so a poison event cannot stall
                            // the curve indefinitely; already-stored events are skipped via dedup.
                            const retries = (updatedData && updatedData.failRetries) || 0;
                            if (retries < 3) {
                                newLastBlock = Math.max(lastBlock, minFailedBlock - 1);
                                if (updatedData) updatedData.failRetries = retries + 1;
                                holdForRetry = true;
                            } else {
                                console.warn(`  ⚠ [EVM] Skipping block ${minFailedBlock} for ${address} after ${retries} failed retries`);
                                if (updatedData) updatedData.failRetries = 0;
                            }
                        } else if (updatedData) {
                            updatedData.failRetries = 0;
                        }

                        if (updatedData) updatedData.lastBlock = newLastBlock;
                        this.lastBondingCurveBlocks.set(address, newLastBlock);

                        // Stop scanning further batches this cycle; resume from the held block next poll.
                        if (holdForRetry) break;
                    }
                } catch (error) {
                    cycleHadFailure = true; // an eth_getLogs / RPC query failed for this curve
                    console.error(`  ✗ Error polling ${address}:`, error.message);
                    // Invalid block range indicates WebSocket/provider degradation - recycle immediately
                    if (error.message && String(error.message).includes('invalid block range')) {
                        const updatedData = this.bondingCurveListeners.get(address);
                        if (updatedData) {
                            updatedData.lastBlock = Math.max(0, latestBlock - 100);
                            console.warn(`  [EVM] Invalid block range for ${address} - triggering recycle`);
                        }
                        this.forceRecycleEVM('invalid-block-range-params').catch(() => {});
                        return;
                    }
                }
            }

            // Count the cycle: a clean cycle resets the counter; any RPC failure advances
            // toward a recycle even when getBlockNumber() itself is still working.
            if (cycleHadFailure) {
                this.consecutivePollFailures = (this.consecutivePollFailures || 0) + 1;
                if (this.consecutivePollFailures >= POLL_FAILURE_THRESHOLD) {
                    console.warn(`[EVM] ${this.consecutivePollFailures} consecutive poll failures - triggering recycle`);
                    this.forceRecycleEVM('consecutive-poll-failures').catch(() => {});
                }
            } else {
                this.consecutivePollFailures = 0;
            }
        } catch (error) {
            this.consecutivePollFailures = (this.consecutivePollFailures || 0) + 1;
            console.error(`Error in pollForBondingCurveEvents (failures: ${this.consecutivePollFailures}):`, error.message);
            if (this.consecutivePollFailures >= POLL_FAILURE_THRESHOLD) {
                console.warn(`[EVM] ${this.consecutivePollFailures} consecutive poll failures - triggering recycle`);
                this.forceRecycleEVM('consecutive-poll-failures').catch(() => {});
            }
        } finally {
            this.isPolling = false;
        }
    }

    /**
     * Start periodic catch-up to ensure no events are missed
     */
    startPeriodicCatchUp() {
        // Clear any existing interval
        if (this.catchUpInterval) {
            clearInterval(this.catchUpInterval);
        }
        
        // Run catch-up every 5 minutes
        this.catchUpInterval = setInterval(async () => {
            try {
                console.log('Running periodic catch-up...');

                // Detect stalled EVM: if provider fails or we have many poll failures, recycle
                if (this.bondingCurveListeners.size > 0 && !this.isRecycling) {
                    try {
                        await this.provider.getBlockNumber();
                    } catch (providerErr) {
                        console.warn('[EVM] Provider getBlockNumber failed during catch-up, triggering recycle:', providerErr.message);
                        this.forceRecycleEVM('provider-getBlockNumber-failed').catch(() => {});
                        return;
                    }
                    if (this.consecutivePollFailures >= POLL_FAILURE_THRESHOLD) {
                        console.warn(`[EVM] Poll failures at ${this.consecutivePollFailures} during catch-up - triggering recycle`);
                        this.forceRecycleEVM('poll-failures-during-catchup').catch(() => {});
                        return;
                    }
                }
                
                // Catch up factory events
                if (this.factoryAddress) {
                    await this.catchUpFactoryEvents();
                }
                
                // Catch up bonding curve events
                for (const [address] of this.bondingCurveListeners) {
                    await this.catchUpBondingCurveEvents(address);
                }
            } catch (error) {
                console.error('Periodic catch-up error:', error.message);
                // If catch-up throws (e.g. provider dead), trigger recycle
                if (this.bondingCurveListeners.size > 0 && !this.isRecycling) {
                    console.warn('[EVM] Catch-up error - triggering recycle');
                    this.forceRecycleEVM('catch-up-error').catch(() => {});
                }
            }
        }, 5 * 60 * 1000); // 5 minutes
        
        console.log('  ✓ Periodic catch-up scheduled (every 5 minutes)');
    }

    /**
     * Stop all listeners and close provider
     */
    async stop() {
        // Clear periodic catch-up interval
        if (this.catchUpInterval) {
            clearInterval(this.catchUpInterval);
            this.catchUpInterval = null;
        }
        
        // Clear polling interval
        if (this.pollingInterval) {
            clearInterval(this.pollingInterval);
            this.pollingInterval = null;
        }
        
        
        // Stop factory listener
        if (this.factoryListener && this.factoryContract) {
            this.factoryContract.removeAllListeners("TokenCreated");
            this.factoryListener = null;
        }

        // Stop bonding curve listeners
        for (const [address, data] of this.bondingCurveListeners) {
            if (data.listener) {
                data.contract.removeAllListeners("TokenTraded");
            }
        }
        this.bondingCurveListeners.clear();
        this.lastBondingCurveBlocks.clear();

        // Close provider
        if (this.provider) {
            await this.provider.destroy();
            this.provider = null;
        }

        console.log('Event listener stopped');
    }

    /**
     * Process an EVM trade from transaction hash (e.g. when frontend reports a completed swap).
     * Fetches receipt, parses TokenTraded event, and inserts into token_price_data.
     * Used as fallback when event listener misses the trade (e.g. bonding curve not being listened to).
     * @param {string} transactionHash - EVM transaction hash (0x...)
     * @param {string} bondingCurveAddress - Bonding curve contract address
     * @returns {Promise<{ success: boolean, processed?: number, error?: string }>}
     */
    async processTradeFromTxHash(transactionHash, bondingCurveAddress) {
        const txHash = (transactionHash || '').toLowerCase().trim();
        const bcAddress = (bondingCurveAddress || '').toLowerCase().trim();
        if (!txHash || !txHash.match(/^0x[a-f0-9]{64}$/)) {
            return { success: false, error: 'Invalid transaction hash' };
        }
        if (!bcAddress || !bcAddress.match(/^0x[a-f0-9]{40}$/)) {
            return { success: false, error: 'Invalid bonding curve address' };
        }

        try {
            if (!this.provider) {
                await this.initialize();
            }

            let receipt = null;
            let retries = 5;
            while (retries > 0) {
                try {
                    receipt = await this.provider.getTransactionReceipt(txHash);
                    if (receipt) break;
                } catch (err) {
                    console.warn(`  processTradeFromTxHash: fetch receipt attempt failed: ${err.message}`);
                }
                retries--;
                if (retries > 0) {
                    await new Promise(resolve => setTimeout(resolve, 800));
                }
            }

            if (!receipt || !receipt.logs || receipt.logs.length === 0) {
                return { success: false, error: 'Transaction not found or no logs (may still be pending)' };
            }

            const bondingCurveContract = new ethers.Contract(
                bcAddress,
                BONDING_CURVE_ABI,
                this.provider
            );
            const tokenTradedFilter = bondingCurveContract.filters.TokenTraded();
            const traderFeeFilter = bondingCurveContract.filters.TraderFee();
            const tokenTradedTopic = tokenTradedFilter.topics ? tokenTradedFilter.topics[0] : null;
            const traderFeeTopic = traderFeeFilter.topics ? traderFeeFilter.topics[0] : null;

            let processed = 0;
            for (const log of receipt.logs) {
                if (log.address.toLowerCase() !== bcAddress) continue;

                try {
                    const parsedLog = bondingCurveContract.interface.parseLog(log);
                    if (!parsedLog) continue;

                    if (parsedLog.name === 'TokenTraded') {
                        if (tokenTradedTopic && log.topics && log.topics[0] !== tokenTradedTopic) continue;
                        const [eventTokenAddress, timestamp, openPrice, closePrice, amount, tokenAmount, trader, isBuy] = parsedLog.args;
                        const eventObj = {
                            transactionHash: receipt.transactionHash,
                            blockNumber: receipt.blockNumber,
                            args: parsedLog.args
                        };
                        await this.handleTokenTradedEvent(
                            bcAddress,
                            eventTokenAddress,
                            timestamp,
                            openPrice,
                            closePrice,
                            amount,
                            tokenAmount,
                            trader,
                            isBuy,
                            eventObj
                        );
                        processed++;
                    } else if (parsedLog.name === 'TraderFee') {
                        if (traderFeeTopic && log.topics && log.topics[0] !== traderFeeTopic) continue;
                        const txHash = (receipt.transactionHash || '').toLowerCase();
                        if (await supabaseService.checkTraderFeeExists(txHash, getEvmChainSlug())) continue;
                        const [trader, tokenAddress, tradeType, platformFee, creatorFee, rewardFee, feeAmount] = parsedLog.args;
                        const eventObj = {
                            transactionHash: receipt.transactionHash,
                            blockNumber: receipt.blockNumber,
                            args: parsedLog.args
                        };
                        await this.handleTraderFeeEvent(
                            bcAddress,
                            trader,
                            tokenAddress,
                            tradeType,
                            platformFee,
                            creatorFee,
                            rewardFee,
                            feeAmount,
                            eventObj
                        );
                    }
                } catch (parseErr) {
                    // Skip logs that don't parse
                }
            }

            return { success: true, processed };
        } catch (error) {
            console.error('processTradeFromTxHash error:', error.message);
            return { success: false, error: error.message };
        }
    }
}

// Singleton instance
let eventListenerInstance = null;

/**
 * Get or create the event listener instance
 */
function getEventListener() {
    if (!eventListenerInstance) {
        eventListenerInstance = new EventListener();
    }
    return eventListenerInstance;
}

module.exports = {
    getEventListener,
    EventListener
};
