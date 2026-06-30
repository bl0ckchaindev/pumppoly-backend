#!/usr/bin/env node

/**
 * Manual catch-up script to process missed events
 * Usage: node scripts/manual-catchup.js <bondingCurveAddress> <startBlock> <endBlock>
 * Example: node scripts/manual-catchup.js 0x0a46c475f22c5a661675031ed651457492178533 10040992 10057000
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const ethers = require('ethers');
const { httpRpcUrl } = require('../src/config');
const BONDING_CURVE_ABI = require('../src/abi/BondingCurveABI.json');
const supabaseService = require('../src/services/supabaseService');
const tokenService = require('../src/services/tokenService');
const blockPersistence = require('../src/services/blockPersistence');

async function manualCatchUp(bondingCurveAddress, startBlock, endBlock) {
    try {
        console.log(`\n🔍 Manual catch-up for ${bondingCurveAddress}`);
        console.log(`   Block range: ${startBlock} to ${endBlock}`);
        
        const provider = new ethers.providers.JsonRpcProvider(httpRpcUrl);
        const contract = new ethers.Contract(bondingCurveAddress, BONDING_CURVE_ABI, provider);
        
        const batchSize = 100;
        let totalEvents = 0;
        let processedEvents = 0;
        
        for (let i = startBlock; i <= endBlock; i += batchSize) {
            const batchEnd = Math.min(i + batchSize - 1, endBlock);
            console.log(`\n   Querying blocks ${i} to ${batchEnd}...`);
            
            try {
                const events = await contract.queryFilter(
                    contract.filters.TokenTraded(),
                    i,
                    batchEnd
                );
                
                totalEvents += events.length;
                
                if (events.length > 0) {
                    console.log(`   ✓ Found ${events.length} event(s) in this batch`);
                }
                
                for (const event of events) {
                    try {
                        const txHash = event.transactionHash;
                        const exists = await supabaseService.checkPriceDataExists(txHash);
                        
                        if (exists) {
                            console.log(`   ⏭️  Skipping duplicate: ${txHash.substring(0, 16)}...`);
                            continue;
                        }
                        
                        const [tokenAddress, timestamp, openPrice, closePrice, amount, tokenAmount, trader, isBuy] = event.args;
                        const eventBlock = event.blockNumber && event.blockNumber.toNumber ? event.blockNumber.toNumber() : Number(event.blockNumber);
                        const timestampNum = timestamp && timestamp.toNumber ? timestamp.toNumber() : Number(timestamp);
                        const isBuyStr = isBuy ? 'BUY' : 'SELL';
                        
                        console.log(`   🟠 Processing: Block ${eventBlock} | ${isBuyStr} | Amount: ${amount.toString()} | Tx: ${txHash.substring(0, 16)}...`);
                        
                        // Get bonding curve to find token address
                        const bondingCurve = await tokenService.getBondingCurveByAddress(bondingCurveAddress);
                        if (!bondingCurve || !bondingCurve.tokenAddress) {
                            console.error(`   ✗ Bonding curve not found in database`);
                            continue;
                        }
                        
                        // Use the same event handler as the main listener
                        const { getEventListener } = require('../src/eventListener');
                        const listener = getEventListener();
                        
                        // Create a mock event object with the necessary properties
                        const mockEvent = {
                            blockNumber: eventBlock,
                            transactionHash: txHash,
                            args: [tokenAddress, timestamp, openPrice, closePrice, amount, tokenAmount, trader, isBuy]
                        };
                        
                        // Use the same handler as the event listener
                        await listener.handleTokenTradedEvent(
                            bondingCurveAddress.toLowerCase(),
                            tokenAddress,
                            timestamp,
                            openPrice,
                            closePrice,
                            amount,
                            tokenAmount,
                            trader,
                            isBuy,
                            mockEvent
                        );
                        
                        // Update lastBlock
                        blockPersistence.updateBondingCurveBlock(bondingCurveAddress.toLowerCase(), eventBlock);
                        
                        processedEvents++;
                        console.log(`   ✓ Processed event at block ${eventBlock}`);
                        
                    } catch (eventError) {
                        console.error(`   ✗ Error processing event:`, eventError.message);
                    }
                }
                
                // Small delay between batches
                await new Promise(resolve => setTimeout(resolve, 100));
                
            } catch (batchError) {
                console.error(`   ✗ Error querying blocks ${i}-${batchEnd}:`, batchError.message);
            }
        }
        
        // Update lastBlock to endBlock
        blockPersistence.updateBondingCurveBlock(bondingCurveAddress.toLowerCase(), endBlock);
        
        console.log(`\n✅ Manual catch-up completed!`);
        console.log(`   Total events found: ${totalEvents}`);
        console.log(`   Events processed: ${processedEvents}`);
        console.log(`   Last block updated to: ${endBlock}`);
        
    } catch (error) {
        console.error('✗ Error in manual catch-up:', error.message);
        console.error(error.stack);
        process.exit(1);
    }
}

// Parse command line arguments
const args = process.argv.slice(2);
if (args.length < 3) {
    console.error('Usage: node scripts/manual-catchup.js <bondingCurveAddress> <startBlock> <endBlock>');
    console.error('Example: node scripts/manual-catchup.js 0x0a46c475f22c5a661675031ed651457492178533 10040992 10057000');
    process.exit(1);
}

const [bondingCurveAddress, startBlock, endBlock] = args;
manualCatchUp(bondingCurveAddress, parseInt(startBlock), parseInt(endBlock))
    .then(() => process.exit(0))
    .catch((error) => {
        console.error('Fatal error:', error);
        process.exit(1);
    });
