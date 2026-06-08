const { Connection, PublicKey } = require('@solana/web3.js');
const { Program, AnchorProvider } = require('@coral-xyz/anchor');
const supabaseService = require('./services/supabaseService');
const tokenService = require('./services/tokenService');
const path = require('path');
const fs = require('fs');

// Load IDL file
const idlPath = path.join(__dirname, './idl/fomo.json');
let IDL;
try {
    const idlFile = fs.readFileSync(idlPath, 'utf8');
    IDL = JSON.parse(idlFile);
} catch (error) {
    console.error('Error loading IDL file:', error);
    throw new Error(`Failed to load IDL from ${idlPath}. Make sure the Solana program is built.`);
}

// Program ID from IDL
const PROGRAM_ID = new PublicKey(IDL.address);
const GLOBAL_CONFIG_SEED = 'global_config';
const BONDING_CURVE_SEED = 'bonding_curve';

// Event discriminators from IDL (fomo.json)
const EVENT_DISCRIMINATORS = {
    CREATE: [96, 6, 69, 34, 20, 216, 249, 240],
    TRADE: [230, 70, 166, 249, 243, 37, 141, 112],
    COMPLETE: [39, 6, 3, 104, 12, 154, 133, 7],
    TRADER_FEE: [211, 72, 153, 86, 46, 196, 23, 17],
    LP_UNLOCKED: [83, 10, 33, 140, 182, 48, 201, 137]
};

class SolanaEventListener {
    constructor() {
        this.connection = null;
        this.program = null;
        this.provider = null;
        this.subscriptionId = null;
        this.lastProcessedSignature = null;
        this.isListening = false;
        this.pollingInterval = null;
        this.processedSignatures = new Set(); // Track processed transactions
        this.eventCoder = null; // Anchor event coder
        this.isProcessing = false; // Prevent overlapping processNewTransactions runs (poll + subscription)
    }

    /**
     * Safely stringify event data, handling BigInt and other non-serializable values
     */
    safeStringifyEventData(eventData) {
        try {
            return JSON.stringify(eventData, (key, value) => {
                if (typeof value === 'bigint') {
                    return value.toString();
                }
                if (value && typeof value === 'object') {
                    // Handle PublicKey and other objects with toString
                    if (value.toString && typeof value.toString === 'function') {
                        try {
                            const str = value.toString();
                            // Only use toString if it returns something meaningful
                            if (str !== '[object Object]') {
                                return str;
                            }
                        } catch (e) {
                            return '[Object]';
                        }
                    }
                }
                return value;
            }, 2);
        } catch (error) {
            // Fallback: try to stringify just the keys
            try {
                return JSON.stringify(Object.keys(eventData || {}));
            } catch (e) {
                return String(eventData);
            }
        }
    }

    /**
     * Initialize Solana connection and program
     */
    async initialize() {
        try {
            const rpcUrl = process.env.SOLANA_RPC_URL;
            this.connection = new Connection(rpcUrl, 'confirmed');
            
            // Create a dummy wallet for provider (we only need it for reading)
            const dummyWallet = {
                publicKey: PublicKey.default,
                signTransaction: async () => {},
                signAllTransactions: async () => {}
            };
            
            this.provider = new AnchorProvider(
                this.connection,
                dummyWallet,
                { commitment: 'confirmed' }
            );
            
            // Ensure IDL has required structure
            if (!IDL || !IDL.address) {
                throw new Error('Invalid IDL: missing address field');
            }
            
            // Create program with IDL (without accounts for event listening)
            const eventOnlyIDL = {
                address: IDL.address,
                metadata: IDL.metadata,
                instructions: IDL.instructions || [],
                accounts: [], // Empty accounts array - we don't need them for events
                events: IDL.events || [],
                errors: IDL.errors || [],
                types: IDL.types || []
            };
            this.program = new Program(eventOnlyIDL, this.provider);
            
            // Event coder will be created from program if needed
            // For now, we'll use manual parsing which is more reliable
            
            console.log('✓ Solana event listener initialized');
            console.log(`  Program ID: ${PROGRAM_ID.toString()}`);
            console.log(`  RPC URL: ${rpcUrl}`);
            
            return true;
        } catch (error) {
            console.error('✗ Error initializing Solana event listener:', error);
            throw error;
        }
    }

    /**
     * Start listening to program events
     */
    async startListening() {
        if (this.isListening) {
            console.log('⚠ Solana event listener already running');
            return;
        }

        try {
            await this.initialize();
            
            console.log(`✓ Starting Solana event listener`);
            
            // Start polling for new transactions
            this.startPolling();
            
            // Also set up a subscription for real-time events
            this.setupSubscription();
            
            this.isListening = true;
        } catch (error) {
            console.error('✗ Error starting Solana event listener:', error);
            throw error;
        }
    }

    /**
     * Poll for new transactions (backup when WebSocket subscription misses)
     */
    startPolling() {
        const pollInterval = 5000; // Poll every 5 seconds (was 10s - balance with RPC rate limits)
        
        this.pollingInterval = setInterval(async () => {
            try {
                await this.processNewTransactions();
            } catch (error) {
                console.error('Error polling Solana transactions:', error.message);
            }
        }, pollInterval);
    }

    /**
     * Setup WebSocket subscription for real-time events
     */
    setupSubscription() {
        try {
            // Subscribe to program account changes (store id so stopListening can unsubscribe)
            this.subscriptionId = this.connection.onProgramAccountChange(
                PROGRAM_ID,
                async (accountInfo, context) => {
                    try {
                        // When account changes, check for new transactions
                        await this.processNewTransactions();
                    } catch (error) {
                        console.error('Error handling account change:', error.message);
                    }
                },
                'confirmed'
            );
        } catch (error) {
            console.error('Error setting up subscription:', error.message);
            // Fallback to polling only
        }
    }

    /**
     * Collect program signatures we have not processed yet, paging backward from the
     * newest until we reach a page that is entirely already-processed (or run out of
     * pages / hit the page cap).
     *
     * Without paging, a burst of more than `pageSize` program transactions between two
     * polls would scroll the older signatures out of the single result window and they
     * would be missed forever. Paging past already-processed signatures (instead of
     * stopping at the first one) also tolerates holes, so a transaction left unprocessed
     * by an earlier error is retried on the next poll even if newer ones already landed.
     *
     * @returns {Promise<string[]>} signatures oldest-first, ready to process in order
     */
    async collectNewSignatures(maxPages = 20, pageSize = 100) {
        const collected = [];
        let before = undefined;

        for (let page = 0; page < maxPages; page++) {
            let sigs;
            try {
                sigs = await this.connection.getSignaturesForAddress(
                    PROGRAM_ID,
                    { limit: pageSize, before, commitment: 'confirmed' }
                );
            } catch (err) {
                // Transient RPC error (e.g. 429): stop paging and process what we have.
                console.error('Error fetching Solana signatures:', err.message);
                break;
            }
            if (!sigs || sigs.length === 0) break;

            let anyNew = false;
            for (const s of sigs) {
                const signature = s.signature;
                if (s.err) { this.processedSignatures.add(signature); continue; } // failed tx
                if (this.processedSignatures.has(signature)) continue;
                let inDb = false;
                try {
                    inDb = await supabaseService.isSolanaTransactionProcessed(signature);
                } catch (e) {
                    // DB check failed — treat as new; the insert is idempotent on tx hash.
                }
                if (inDb) { this.processedSignatures.add(signature); continue; }
                collected.push(signature);
                anyNew = true;
            }

            // A full page with nothing new means we have reached the processed frontier.
            if (!anyNew) break;
            if (sigs.length < pageSize) break; // no older pages exist
            before = sigs[sigs.length - 1].signature;
        }

        return collected.reverse(); // oldest first
    }

    /**
     * Process new transactions since last check.
     */
    async processNewTransactions() {
        if (this.isProcessing) {
            // Both the 5s poll and the onProgramAccountChange subscription call this. Without
            // a guard, concurrent runs double-fetch the same transactions (wasted RPC → more
            // 429s) and can re-enter handlers before signatures are marked processed.
            return;
        }
        this.isProcessing = true;
        try {
            await this._processNewTransactions();
        } finally {
            this.isProcessing = false;
        }
    }

    async _processNewTransactions() {
        const newSignatures = await this.collectNewSignatures();

        for (const signature of newSignatures) {
            let tx;
            try {
                tx = await this.connection.getTransaction(signature, {
                    commitment: 'confirmed',
                    maxSupportedTransactionVersion: 0
                });
            } catch (error) {
                // Transient RPC error: do NOT mark processed — retry on the next poll.
                console.error(`Error fetching transaction ${signature}:`, error.message);
                const is429 = (error.message || '').includes('429') || /too many requests/i.test(error.message || '');
                if (is429) break; // back off for this cycle; the next poll retries
                continue;
            }

            if (!tx) {
                // Not yet available at this commitment — leave unprocessed for the next poll.
                continue;
            }
            if (!tx.meta || tx.meta.err) {
                // Failed/irrelevant tx — mark processed so we don't keep refetching it.
                this.processedSignatures.add(signature);
                continue;
            }

            try {
                await this.processTransactionEvents(tx, signature);
                this.processedSignatures.add(signature);
            } catch (eventError) {
                if (eventError.message && (
                    eventError.message.includes('duplicate key') ||
                    eventError.message.includes('unique constraint') ||
                    eventError.code === '23505' ||
                    eventError.code === 'PGRST204'
                )) {
                    // Already stored (race) — safe to mark processed.
                    this.processedSignatures.add(signature);
                } else {
                    // Real failure — leave unprocessed so the next poll retries it.
                    console.error(`  ✗ Failed to process events for ${signature}:`, eventError.message);
                }
            }

            // Bound the in-memory set well above one poll's worth of signatures so the
            // paging frontier is not evicted between polls.
            if (this.processedSignatures.size > 5000) {
                const first = this.processedSignatures.values().next().value;
                this.processedSignatures.delete(first);
            }
        }
    }

    /**
     * Process events from a transaction
     */
    async processTransactionEvents(transaction, signature) {
        try {
            const logs = transaction.meta?.logMessages || [];
            
            // Try to decode events using Anchor's program event coder
            let decodedEvents = [];
            try {
                // Use program's event coder if available
                if (this.program && this.program.coder && this.program.coder.events) {
                    decodedEvents = this.program.coder.events.decodeAll(logs);
                }
            } catch (decodeError) {
                // If decoding fails, try manual parsing
                // This is expected if IDL doesn't have full account definitions
            }

            // Process decoded events
            for (const event of decodedEvents) {
                if (event.name === 'CREATE') {
                    await this.handleCreateEvent(event.data, transaction, signature);
                } else if (event.name === 'TRADE') {
                    await this.handleTradeEvent(event.data, transaction, signature);
                } else if (event.name === 'COMPLETE') {
                    await this.handleCompleteEvent(event.data, transaction, signature);
                } else if (event.name === 'TRADER_FEE') {
                    await this.handleTraderFeeEvent(event.data, transaction, signature);
                } else if (event.name === 'LP_UNLOCKED') {
                    await this.handleLpUnlockedEvent(event.data, transaction, signature);
                }
            }

            // If no events decoded, try manual parsing from logs
            if (decodedEvents.length === 0) {
                await this.parseEventsFromLogs(logs, transaction, signature);
            }
        } catch (error) {
            console.error('Error processing transaction events:', error.message);
            // Try manual parsing as fallback
            const logs = transaction.meta?.logMessages || [];
            await this.parseEventsFromLogs(logs, transaction, signature);
        }
    }

    /**
     * Parse events manually from transaction logs (fallback)
     */
    async parseEventsFromLogs(logs, transaction, signature) {
        try {
            // Anchor events are logged in a specific format
            // Look for logs that contain event data
            for (let i = 0; i < logs.length; i++) {
                const log = logs[i];
                
                // Anchor events can appear in different log formats:
                // 1. "Program data: <base64>" - older format
                // 2. "Program log: <base64>" - newer format
                // 3. Direct base64 data in inner instructions
                
                let base64Data = null;
                if (log.includes('Program data:')) {
                    base64Data = log.split('Program data:')[1]?.trim();
                } else if (log.includes('Program log:')) {
                    // Check if it's base64 encoded event data
                    const logData = log.split('Program log:')[1]?.trim();
                    // Try to decode - if it fails, it's not event data
                    try {
                        Buffer.from(logData, 'base64');
                        base64Data = logData;
                    } catch (e) {
                        // Not base64, skip
                    }
                }
                
                if (base64Data) {
                    try {
                        const eventData = Buffer.from(base64Data, 'base64');
                        if (eventData.length < 8) continue;
                        
                        const discriminator = Array.from(eventData.slice(0, 8));
                        
                        // Check which event this is
                        if (this.arrayEquals(discriminator, EVENT_DISCRIMINATORS.CREATE)) {
                            await this.parseCreateEvent(eventData, transaction, signature);
                        } else if (this.arrayEquals(discriminator, EVENT_DISCRIMINATORS.TRADE)) {
                            await this.parseTradeEvent(eventData, transaction, signature);
                        } else if (this.arrayEquals(discriminator, EVENT_DISCRIMINATORS.COMPLETE)) {
                            await this.parseCompleteEvent(eventData, transaction, signature);
                        } else if (this.arrayEquals(discriminator, EVENT_DISCRIMINATORS.TRADER_FEE)) {
                            await this.parseTraderFeeEvent(eventData, transaction, signature);
                        } else if (this.arrayEquals(discriminator, EVENT_DISCRIMINATORS.LP_UNLOCKED)) {
                            await this.parseLpUnlockedEvent(eventData, transaction, signature);
                        }
                    } catch (parseError) {
                        // Not an event, continue
                        continue;
                    }
                }
            }

            // Also check inner instructions for event data
            const innerInstructions = transaction.meta?.innerInstructions || [];
            for (const innerIx of innerInstructions) {
                for (const ix of innerIx.instructions || []) {
                    if (ix.data) {
                        try {
                            const eventData = Buffer.from(ix.data, 'base64');
                            if (eventData.length < 8) continue;
                            
                            const discriminator = Array.from(eventData.slice(0, 8));
                            
                            if (this.arrayEquals(discriminator, EVENT_DISCRIMINATORS.CREATE)) {
                                await this.parseCreateEvent(eventData, transaction, signature);
                            } else if (this.arrayEquals(discriminator, EVENT_DISCRIMINATORS.TRADE)) {
                                await this.parseTradeEvent(eventData, transaction, signature);
                            } else if (this.arrayEquals(discriminator, EVENT_DISCRIMINATORS.COMPLETE)) {
                                await this.parseCompleteEvent(eventData, transaction, signature);
                            } else if (this.arrayEquals(discriminator, EVENT_DISCRIMINATORS.TRADER_FEE)) {
                                await this.parseTraderFeeEvent(eventData, transaction, signature);
                            } else if (this.arrayEquals(discriminator, EVENT_DISCRIMINATORS.LP_UNLOCKED)) {
                                await this.parseLpUnlockedEvent(eventData, transaction, signature);
                            }
                        } catch (parseError) {
                            // Not an event, continue
                        }
                    }
                }
            }
        } catch (error) {
            console.error('Error parsing events from logs:', error.message);
        }
    }

    /**
     * Handle CREATE event
     */
    async handleCreateEvent(eventData, transaction, signature) {
        try {
            // Handle both object format (from decoder) and parsed format
            const creator = eventData.creator ? 
                (typeof eventData.creator === 'string' ? eventData.creator : new PublicKey(eventData.creator).toString()) :
                eventData.creator.toString();
            const mint = eventData.mint ? 
                (typeof eventData.mint === 'string' ? eventData.mint : new PublicKey(eventData.mint).toString()) :
                eventData.mint.toString();
            const name = eventData.name || '';
            const symbol = eventData.symbol || '';
            const decimals = eventData.decimals || 6;
            const uri = eventData.uri || '';
            const liquidityLockSecs = eventData.liquidityLockSecs != null
                ? Number(eventData.liquidityLockSecs)
                : (eventData.liquidity_lock_secs != null ? Number(eventData.liquidity_lock_secs) : null);

            // Check if token already exists
            const existingToken = await supabaseService.getTokenByAddress(mint, 'solana');
            if (existingToken) {
                console.log(`  ℹ Token ${mint} already exists, skipping`);
                return; // Already processed
            }

            // Derive bonding curve address
            const [bondingCurvePubkey] = PublicKey.findProgramAddressSync(
                [Buffer.from(BONDING_CURVE_SEED), new PublicKey(mint).toBuffer()],
                PROGRAM_ID
            );
            const bondingCurveAddress = bondingCurvePubkey.toString();

            // Get transaction details
            const blockTime = transaction.blockTime || Math.floor(Date.now() / 1000);
            const slot = transaction.slot || 0;

            // Create token in database
            console.log(`  📝 Saving token to database...`);
            const result = await tokenService.createToken({
                tokenAddress: mint,
                bondingCurveAddress: bondingCurveAddress,
                chain: 'solana',
                creator: creator,
                name: name || 'Unknown',
                symbol: symbol || 'UNK',
                description: '',
                website: '',
                twitter: '',
                telegram: '',
                discord: '',
                logoUrl: uri || '',
                bannerUrl: '',
                totalSupply: '1000000000000000', // TOTAL_SUPPLY from program (1 billion with 6 decimals)
                decimals: decimals || 6,
                transactionHash: signature, // Solana transaction signature (base58, not lowercased)
                blockNumber: slot,
                timestamp: blockTime,
                initialPrice: '0',
                feeAmount: '0',
                // Initial bonding curve values from create_token.rs:
                virtualEthLp: '30000000000', // virtual_quote_reserves = 30 SOL (30_000_000_000 lamports)
                virtualTokenLp: '1073000000000000', // virtual_base_reserves = 1.073 trillion
                realEthLp: '0', // real_quote_reserves = 0 SOL
                realTokenLp: '793100000000000', // real_base_reserves = 793.1 billion
                k: '32190000000000000000', // k = virtual_eth_lp * virtual_token_lp = 30_000_000_000 * 1_073_000_000_000_000
                tokenStartPrice: '0',
                volume: '0',
                lpCreated: false,
                liquidityLockDurationSeconds: liquidityLockSecs != null && !Number.isNaN(liquidityLockSecs)
                    ? String(liquidityLockSecs)
                    : undefined
            });

            console.log(`✓ Processed Solana CREATE event: ${mint} (${name})`);
            console.log(`  ✅ Token saved to database: ${mint}`);
            console.log(`  ✅ Bonding curve saved: ${bondingCurveAddress}`);
            console.log(`  📊 Result: ${result.isNew ? 'NEW' : 'EXISTING'} token`);
        } catch (error) {
            console.error('✗ Error handling CREATE event:', error.message);
            console.error('  Stack:', error.stack);
            console.error('  Event data:', this.safeStringifyEventData(eventData));
            // Re-throw to prevent silent failures
            throw error;
        }
    }

    /**
     * Parse CREATE event manually from binary data
     */
    async parseCreateEvent(eventData, transaction, signature) {
        try {
            let offset = 8; // Skip discriminator
            
            // Parse creator (32 bytes)
            const creator = new PublicKey(eventData.slice(offset, offset + 32));
            offset += 32;
            
            // Parse mint (32 bytes)
            const mint = new PublicKey(eventData.slice(offset, offset + 32));
            offset += 32;
            
            // Parse name (String - 4 bytes length + data)
            const nameLength = eventData.readUInt32LE(offset);
            offset += 4;
            const name = eventData.slice(offset, offset + nameLength).toString('utf8');
            offset += nameLength;
            
            // Parse symbol (String)
            const symbolLength = eventData.readUInt32LE(offset);
            offset += 4;
            const symbol = eventData.slice(offset, offset + symbolLength).toString('utf8');
            offset += symbolLength;
            
            // Parse decimals (u8)
            const decimals = eventData[offset];
            offset += 1;
            
            // Parse uri (String)
            const uriLength = eventData.readUInt32LE(offset);
            offset += 4;
            const uri = eventData.slice(offset, offset + uriLength).toString('utf8');
            offset += uriLength;

            let liquidityLockSecs = 0;
            if (eventData.length >= offset + 8) {
                liquidityLockSecs = Number(eventData.readBigUInt64LE(offset));
            }

            await this.handleCreateEvent({
                creator,
                mint,
                name,
                symbol,
                decimals,
                uri,
                liquidityLockSecs
            }, transaction, signature);
        } catch (error) {
            console.error('✗ Error parsing CREATE event:', error.message);
            console.error('  Stack:', error.stack);
            throw error;
        }
    }

    /**
     * Handle TRADE event
     */
    async handleTradeEvent(eventData, transaction, signature) {
        try {
            // Helper function to safely convert values to string
            const safeToString = (value, fallback = '0') => {
                if (value === null || value === undefined) return fallback;
                if (typeof value === 'string') return value;
                if (typeof value === 'object' && value.toString) return value.toString();
                return String(value);
            };

            // Helper function to safely get PublicKey as string
            const safePublicKey = (value) => {
                if (!value) return null;
                if (typeof value === 'string') return value;
                try {
                    return new PublicKey(value).toString();
                } catch (e) {
                    return String(value);
                }
            };

            // Handle both object format (from decoder) and parsed format
            const user = safePublicKey(eventData.user);
            if (!user) {
                throw new Error('Missing user in TRADE event');
            }

            const mint = safePublicKey(eventData.mint);
            if (!mint) {
                throw new Error('Missing mint in TRADE event');
            }

            const tradeType = eventData.trade_type !== undefined ? eventData.trade_type : (eventData.tradeType !== undefined ? eventData.tradeType : null);
            if (tradeType === null) {
                throw new Error('Missing trade_type in TRADE event');
            }

            const baseAmount = safeToString(eventData.base_amount || eventData.baseAmount, '0');
            const quoteAmount = safeToString(eventData.quote_amount || eventData.quoteAmount, '0');
            const realBaseReserves = safeToString(eventData.real_base_before || eventData.realBaseBefore, '0');
            const realQuoteReserves = safeToString(eventData.real_quote_before || eventData.realQuoteBefore, '0');
            const virtualBaseReserves = safeToString(eventData.virtual_base_before || eventData.virtualBaseBefore, '0');
            const virtualQuoteReserves = safeToString(eventData.virtual_quote_before || eventData.virtualQuoteBefore, '0');

            // Derive bonding curve address
            const [bondingCurvePubkey] = PublicKey.findProgramAddressSync(
                [Buffer.from(BONDING_CURVE_SEED), new PublicKey(mint).toBuffer()],
                PROGRAM_ID
            );
            const bondingCurveAddress = bondingCurvePubkey.toString();

            // Get bonding curve from DB
            const bondingCurve = await supabaseService.getBondingCurveByAddress(bondingCurveAddress, 'solana');
            if (!bondingCurve) {
                console.log(`  ⚠ Bonding curve not found for ${mint}, skipping trade`);
                console.log(`  💡 This trade will be processed once the token is created via CREATE event`);
                return; // Bonding curve not found - token might not be indexed yet
            }

            console.log(`  📝 Processing trade for bonding curve: ${bondingCurveAddress}`);

            const blockTime = transaction.blockTime || Math.floor(Date.now() / 1000);
            const slot = transaction.slot || 0;

            // Solana token price = SOL per token, scaled by 1e15 — same convention as EVM
            // (ETH per token × 1e15), so the price RISES on buys and the chart reads correctly.
            //   SOL/token = (quote_lamports/1e9) / (base_units/1e6); ×1e15 => quote*1e12 / base.
            // (baseAmount = token base units traded; quoteAmount = SOL lamports.)
            const price = quoteAmount && baseAmount && BigInt(baseAmount) > 0n
                ? ((BigInt(quoteAmount) * 1000000000000n) / BigInt(baseAmount)).toString()
                : '0';
            // Calculate k value (constant product: virtual_eth_lp * virtual_token_lp)
            const kValue = (BigInt(virtualQuoteReserves) * BigInt(virtualBaseReserves)).toString();

            // Open price: previous price, or for the first buy the initial curve price in the same
            // unit: virtual_quote*1e12 / virtual_base (SOL per token × 1e15).
            const hasPreviousPrice = bondingCurve.currentPrice && bondingCurve.currentPrice !== '0';
            let openPrice;
            if (hasPreviousPrice) {
                openPrice = bondingCurve.currentPrice;
            } else {
                const vBase = BigInt(virtualBaseReserves);
                const vQuote = BigInt(virtualQuoteReserves);
                openPrice = vBase > 0n ? ((vQuote * 1000000000000n) / vBase).toString() : price;
            }

            // Insert price data FIRST as the idempotency gate (token_price_data.transaction_hash
            // is unique). If this trade is already recorded, return before touching the bonding
            // curve — otherwise a retry (e.g. a TRADER_FEE insert in the same tx failing) would
            // increment `volume` again. Reserves come from the event's absolute "before" snapshot
            // so re-applying them is harmless, but volume is accumulated and must run once per tx.
            let priceInserted = null;
            try {
                priceInserted = await supabaseService.addTokenPriceData({
                    tokenAddress: mint,
                    chain: 'solana',
                    timestamp: blockTime,
                    openPrice: openPrice, // Previous price (token base units per 1 SOL)
                    closePrice: price,    // New price after trade (token base units per 1 SOL)
                    amount: BigInt(quoteAmount).toString(), // SOL lamports (chart scales by 1e9)
                    trader: user,
                    isBuy: tradeType,
                    transactionHash: signature,
                    blockNumber: slot
                });
                if (priceInserted) {
                    console.log(`  ✅ Token price data saved for chart: ${signature}`);
                }
            } catch (priceError) {
                if (priceError.message && (
                    priceError.message.includes('duplicate key') ||
                    priceError.message.includes('unique constraint') ||
                    priceError.code === '23505' ||
                    priceError.code === 'PGRST204'
                )) {
                    priceInserted = null; // already recorded
                } else {
                    // Transient failure inserting price data: rethrow so the whole tx is retried.
                    throw priceError;
                }
            }

            if (!priceInserted) {
                console.log(`  ℹ Trade ${signature} already recorded, skipping curve/volume update`);
                return;
            }

            // Update bonding curve reserves, price, k and (accumulated) volume — runs once per tx.
            // Non-fatal: a failure here must NOT retry the tx (that would re-run the volume add).
            try {
                await supabaseService.updateBondingCurve(bondingCurveAddress, {
                    chain: 'solana', // Required for address normalization
                    realEthLp: realQuoteReserves,
                    realTokenLp: realBaseReserves,
                    virtualEthLp: virtualQuoteReserves,
                    virtualTokenLp: virtualBaseReserves,
                    k: kValue, // Update k value with new reserves
                    currentPrice: price, // Update current price for InfoCard display
                    volume: (BigInt(bondingCurve.volume || '0') + BigInt(quoteAmount)).toString()
                });
                console.log(`  ✅ Bonding curve updated successfully (price: ${price})`);
            } catch (updateError) {
                console.error(`  ✗ Failed to update bonding curve:`, updateError.message);
            }
            
            // Save trade history
            try {
                await supabaseService.addTradeHistory({
                    tokenAddress: mint,
                    bondingCurveAddress: bondingCurveAddress,
                    chain: 'solana',
                    trader: user,
                    isBuy: tradeType,
                    ethAmount: quoteAmount, // SOL amount
                    tokenAmount: baseAmount,
                    price: price,
                    transactionHash: signature,
                    blockNumber: slot,
                    timestamp: blockTime
                });
                console.log(`  ✅ Trade history saved: ${signature}`);
            } catch (historyError) {
                // Handle duplicate key errors gracefully (race condition)
                if (historyError.message && (
                    historyError.message.includes('duplicate key') ||
                    historyError.message.includes('unique constraint') ||
                    historyError.code === '23505' ||
                    historyError.code === 'PGRST204'
                )) {
                    console.log(`  ℹ Trade ${signature} already exists, skipping (duplicate)`);
                    // Don't throw - this is expected in race conditions
                } else {
                    console.error(`  ✗ Failed to save trade history:`, historyError.message);
                    // Non-fatal: price data (the idempotency gate) is already stored, so do NOT
                    // rethrow — a retry would re-run the volume update above and double-count it.
                }
            }

            // Refresh the trader's on-chain holder balance (fire-and-forget; cron does full sync).
            try {
                require('./services/holderService').refreshSolanaAddress(mint, user, 'solana').catch(() => {});
            } catch (e) { /* ignore */ }

            console.log(`✓ Processed Solana TRADE event: ${tradeType ? 'BUY' : 'SELL'} ${baseAmount} token units for ${quoteAmount} lamports @ price (token/1 SOL) ${price}`);
            console.log(`  ✅ Bonding curve updated: ${bondingCurveAddress}`);
        } catch (error) {
            console.error('✗ Error handling TRADE event:', error.message);
            console.error('  Stack:', error.stack);
            console.error('  Event data:', this.safeStringifyEventData(eventData));
            // Re-throw to prevent silent failures
            throw error;
        }
    }

    /**
     * Parse TRADE event manually from binary data
     */
    async parseTradeEvent(eventData, transaction, signature) {
        try {
            let offset = 8; // Skip discriminator
            
            // Parse user (32 bytes)
            const user = new PublicKey(eventData.slice(offset, offset + 32));
            offset += 32;
            
            // Parse mint (32 bytes)
            const mint = new PublicKey(eventData.slice(offset, offset + 32));
            offset += 32;
            
            // Parse trade_type (bool - 1 byte)
            const tradeType = eventData[offset] === 1;
            offset += 1;
            
            // Parse u64 values (8 bytes each)
            const baseAmount = eventData.readBigUInt64LE(offset);
            offset += 8;
            const quoteAmount = eventData.readBigUInt64LE(offset);
            offset += 8;
            const realBaseBefore = eventData.readBigUInt64LE(offset);
            offset += 8;
            const realQuoteBefore = eventData.readBigUInt64LE(offset);
            offset += 8;
            const virtualBaseBefore = eventData.readBigUInt64LE(offset);
            offset += 8;
            const virtualQuoteBefore = eventData.readBigUInt64LE(offset);
            offset += 8;
            const platformFee = eventData.readBigUInt64LE(offset);
            offset += 8;
            const creatorFee = eventData.readBigUInt64LE(offset);

            await this.handleTradeEvent({
                user,
                mint,
                trade_type: tradeType,
                base_amount: baseAmount,
                quote_amount: quoteAmount,
                real_base_before: realBaseBefore,
                real_quote_before: realQuoteBefore,
                virtual_base_before: virtualBaseBefore,
                virtual_quote_before: virtualQuoteBefore,
                platform_fee: platformFee,
                creator_fee: creatorFee
            }, transaction, signature);
        } catch (error) {
            console.error('✗ Error parsing TRADE event:', error.message);
            console.error('  Stack:', error.stack);
            throw error;
        }
    }

    /**
     * Handle COMPLETE event (migration/graduation)
     */
    async handleCompleteEvent(eventData, transaction, signature) {
        try {
            // Handle both object format (from decoder) and parsed format
            const mint = eventData.mint ? 
                (typeof eventData.mint === 'string' ? eventData.mint : new PublicKey(eventData.mint).toString()) :
                eventData.mint.toString();
            const lpMint = eventData.lp_mint ? 
                (typeof eventData.lp_mint === 'string' ? eventData.lp_mint : new PublicKey(eventData.lp_mint).toString()) :
                (eventData.lpMint ? new PublicKey(eventData.lpMint).toString() : eventData.lp_mint.toString());
            const pool = eventData.pool ? 
                (typeof eventData.pool === 'string' ? eventData.pool : new PublicKey(eventData.pool).toString()) :
                eventData.pool.toString();

            // Derive bonding curve address
            const [bondingCurvePubkey] = PublicKey.findProgramAddressSync(
                [Buffer.from(BONDING_CURVE_SEED), new PublicKey(mint).toBuffer()],
                PROGRAM_ID
            );
            const bondingCurveAddress = bondingCurvePubkey.toString();

            // Check if bonding curve exists
            const bondingCurve = await supabaseService.getBondingCurveByAddress(bondingCurveAddress, 'solana');
            if (!bondingCurve) {
                console.log(`  ⚠ Bonding curve not found for ${mint}, cannot update status`);
                return; // Bonding curve not found
            }

            console.log(`  📝 Updating bonding curve status to completed: ${bondingCurveAddress}`);

            const unlockTs = eventData.liquidity_unlock_ts != null
                ? Number(eventData.liquidity_unlock_ts)
                : (eventData.liquidityUnlockTs != null ? Number(eventData.liquidityUnlockTs) : null);

            // Update bonding curve status
            try {
                await supabaseService.updateBondingCurve(bondingCurveAddress, {
                    chain: 'solana', // Required for address normalization
                    lpCreated: true,
                    status: 'completed',
                    ...(unlockTs != null && !Number.isNaN(unlockTs) ? { liquidityUnlockTimestamp: unlockTs } : {})
                });
                console.log(`  ✅ Bonding curve status updated to completed`);
            } catch (updateError) {
                console.error(`  ✗ Failed to update bonding curve status:`, updateError.message);
                throw updateError;
            }

            // Store pool information (if pools table exists)
            // This would require a pools table in Supabase

            console.log(`✓ Processed Solana COMPLETE event: ${mint} migrated to pool ${pool}`);
            console.log(`  ✅ Bonding curve status updated to completed: ${bondingCurveAddress}`);
        } catch (error) {
            console.error('✗ Error handling COMPLETE event:', error.message);
            console.error('  Stack:', error.stack);
            console.error('  Event data:', this.safeStringifyEventData(eventData));
            // Re-throw to prevent silent failures
            throw error;
        }
    }

    /**
     * Handle LP_UNLOCKED (creator or migrator received Raydium LP tokens)
     */
    async handleLpUnlockedEvent(eventData, transaction, signature) {
        try {
            const mint = eventData.mint
                ? (typeof eventData.mint === 'string' ? eventData.mint : new PublicKey(eventData.mint).toString())
                : eventData.mint.toString();

            const [bondingCurvePubkey] = PublicKey.findProgramAddressSync(
                [Buffer.from(BONDING_CURVE_SEED), new PublicKey(mint).toBuffer()],
                PROGRAM_ID
            );
            const bondingCurveAddress = bondingCurvePubkey.toString();

            const bondingCurve = await supabaseService.getBondingCurveByAddress(bondingCurveAddress, 'solana');
            if (!bondingCurve) {
                console.log(`  ⚠ Bonding curve not found for LP_UNLOCKED ${mint}`);
                return;
            }

            await supabaseService.updateBondingCurve(bondingCurveAddress, {
                chain: 'solana',
                lpUnlocked: true
            });
            console.log(`✓ Processed LP_UNLOCKED for ${mint} (sig ${signature?.slice?.(0, 8) || ''}…)`);
        } catch (error) {
            console.error('✗ Error handling LP_UNLOCKED event:', error.message);
            throw error;
        }
    }

    /**
     * Parse LP_UNLOCKED from binary (Anchor event)
     */
    async parseLpUnlockedEvent(eventData, transaction, signature) {
        try {
            let offset = 8;
            const mint = new PublicKey(eventData.slice(offset, offset + 32));
            offset += 32;
            const migrator = new PublicKey(eventData.slice(offset, offset + 32));
            offset += 32;
            const amount = eventData.readBigUInt64LE(offset);

            await this.handleLpUnlockedEvent({
                mint,
                migrator,
                amount: amount.toString()
            }, transaction, signature);
        } catch (error) {
            console.error('✗ Error parsing LP_UNLOCKED event:', error.message);
            throw error;
        }
    }

    /**
     * Parse COMPLETE event manually from binary data
     */
    async parseCompleteEvent(eventData, transaction, signature) {
        try {
            let offset = 8; // Skip discriminator
            
            // Parse mint (32 bytes)
            const mint = new PublicKey(eventData.slice(offset, offset + 32));
            offset += 32;
            
            // Parse lp_mint (32 bytes)
            const lpMint = new PublicKey(eventData.slice(offset, offset + 32));
            offset += 32;
            
            // Parse pool (32 bytes)
            const pool = new PublicKey(eventData.slice(offset, offset + 32));
            offset += 32;

            let liquidityUnlockTs = null;
            if (eventData.length >= offset + 8) {
                liquidityUnlockTs = Number(eventData.readBigInt64LE(offset));
            }

            await this.handleCompleteEvent({
                mint,
                lp_mint: lpMint,
                pool,
                liquidity_unlock_ts: liquidityUnlockTs
            }, transaction, signature);
        } catch (error) {
            console.error('✗ Error parsing COMPLETE event:', error.message);
            console.error('  Stack:', error.stack);
            throw error;
        }
    }

    /**
     * Handle TRADER_FEE event (fee allocated to trader on buy/sell)
     */
    async handleTraderFeeEvent(eventData, transaction, signature) {
        try {
            const safePublicKey = (value) => {
                if (!value) return null;
                if (typeof value === 'string') return value;
                try {
                    return new PublicKey(value).toString();
                } catch (e) {
                    return String(value);
                }
            };
            const safeBigInt = (v) => {
                if (v == null) return '0';
                if (typeof v === 'bigint') return v.toString();
                if (typeof v === 'string') return v;
                return String(v);
            };

            const user = safePublicKey(eventData.user);
            const mint = safePublicKey(eventData.mint);
            if (!user || !mint) {
                console.log('  ⚠ TRADER_FEE missing user or mint, skipping');
                return;
            }

            const tradeType  = eventData.trade_type  !== undefined ? eventData.trade_type  : (eventData.tradeType  !== undefined ? eventData.tradeType  : false);
            const platformFee = safeBigInt(eventData.platform_fee ?? eventData.platformFee ?? 0);
            const creatorFee  = safeBigInt(eventData.creator_fee  ?? eventData.creatorFee  ?? 0);
            const rewardFee   = safeBigInt(eventData.reward_fee   ?? eventData.rewardFee   ?? 0);
            const feeAmount   = safeBigInt(eventData.fee_amount   ?? eventData.feeAmount   ?? 0);

            const blockTime = transaction.blockTime || Math.floor(Date.now() / 1000);
            const slot = transaction.slot || 0;

            console.log('[god-log] handleTraderFeeEvent',
                `user: ${user}`,
                `mint: ${mint}`,
                `tradeType: ${tradeType}`,
                `platformFee: ${platformFee}`,
                `creatorFee: ${creatorFee}`,
                `rewardFee: ${rewardFee}`,
                `feeAmount: ${feeAmount}`,
                `blockTime: ${blockTime}`,
                `slot: ${slot}`,
                `signature: ${signature}`,
            );

            try {
                await supabaseService.insertTraderFee({
                    walletAddress: user,
                    mint,
                    tradeType,
                    platformFee,
                    creatorFee,
                    rewardFee,
                    feeAmount,
                    transactionHash: signature,
                    slot,
                    blockTime
                });
                // Accumulate creator fee for this token (for creator distribution at round end)
                if (creatorFee && BigInt(creatorFee) > 0n) {
                    try {
                        await supabaseService.incrementTokenCreatorFee(mint, 'solana', creatorFee);
                    } catch (incErr) {
                        console.error('  ⚠ Failed to increment token creator fee:', incErr.message);
                    }
                }
                console.log(`✓ Processed Solana TRADER_FEE: ${user} fee_amount=${feeAmount} (${tradeType ? 'buy' : 'sell'})`);
            } catch (insertError) {
                if (insertError.message && (
                    insertError.message.includes('duplicate key') ||
                    insertError.message.includes('unique constraint') ||
                    insertError.code === '23505' ||
                    insertError.code === 'PGRST204'
                )) {
                    console.log(`  ℹ TRADER_FEE ${signature} already stored, skipping`);
                } else {
                    throw insertError;
                }
            }
        } catch (error) {
            console.error('✗ Error handling TRADER_FEE event:', error.message);
            console.error('  Event data:', this.safeStringifyEventData(eventData));
            throw error;
        }
    }

    /**
     * Parse TRADER_FEE event manually from binary data
     */
    async parseTraderFeeEvent(eventData, transaction, signature) {
        try {
            let offset = 8; // Skip discriminator
            // IDL layout: user(32) mint(32) trade_type(1) platform_fee(8) creator_fee(8) reward_fee(8) fee_amount(8)
            if (eventData.length < 8 + 32 + 32 + 1 + 8 + 8 + 8 + 8) {
                console.log('  ⚠ TRADER_FEE data too short, skipping');
                return;
            }

            const user = new PublicKey(eventData.slice(offset, offset + 32));
            offset += 32;
            const mint = new PublicKey(eventData.slice(offset, offset + 32));
            offset += 32;
            const tradeType = eventData[offset] === 1;
            offset += 1;
            const platformFee = eventData.readBigUInt64LE(offset);
            offset += 8;
            const creatorFee = eventData.readBigUInt64LE(offset);
            offset += 8;
            const rewardFee = eventData.readBigUInt64LE(offset);
            offset += 8;
            const feeAmount = eventData.readBigUInt64LE(offset);

            await this.handleTraderFeeEvent({
                user: user.toString(),
                mint: mint.toString(),
                trade_type: tradeType,
                platform_fee: platformFee,
                creator_fee: creatorFee,
                reward_fee: rewardFee,
                fee_amount: feeAmount
            }, transaction, signature);
        } catch (error) {
            console.error('✗ Error parsing TRADER_FEE event:', error.message);
            throw error;
        }
    }

    /**
     * Helper to compare arrays
     */
    arrayEquals(a, b) {
        return a.length === b.length && a.every((val, i) => val === b[i]);
    }

    /**
     * Stop listening
     */
    stopListening() {
        if (this.pollingInterval) {
            clearInterval(this.pollingInterval);
            this.pollingInterval = null;
        }
        if (this.subscriptionId) {
            this.connection.removeProgramAccountChangeListener(this.subscriptionId);
            this.subscriptionId = null;
        }
        this.isListening = false;
        console.log('✓ Solana event listener stopped');
    }
}

module.exports = new SolanaEventListener();
