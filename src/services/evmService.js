/**
 * EVM Service for reward distribution operations.
 * Handles ETH transfers from treasury to traders/creators for reward distribution.
 */

const ethers = require('ethers');

class EvmService {
    constructor() {
        this.provider = null;
        this.treasuryWallet = null;
        this.initialized = false;
    }

    /**
     * Initialize the EVM service with provider and treasury wallet.
     * Requires EVM_RPC_URL and EVM_TREASURY_PRIVATE_KEY environment variables.
     */
    async initialize() {
        if (this.initialized) return;

        const rpcUrl = process.env.HTTP_RPC_URL;
        if (!rpcUrl) {
            throw new Error('HTTP_RPC_URL environment variable is required');
        }

        this.provider = new ethers.providers.JsonRpcProvider(rpcUrl);

        const treasuryPrivateKey = process.env.EVM_TREASURY_PRIVATE_KEY;
        if (treasuryPrivateKey) {
            this.treasuryWallet = new ethers.Wallet(treasuryPrivateKey, this.provider);
            console.log(`✓ EVM treasury wallet initialized: ${this.treasuryWallet.address}`);
        } else {
            console.warn('⚠ EVM_TREASURY_PRIVATE_KEY not set; EVM reward payouts will be disabled');
        }

        this.initialized = true;
        console.log('✓ EVM service initialized');
    }

    /**
     * Get the treasury wallet address.
     * @returns {string|null} Treasury wallet address or null if not configured
     */
    getTreasuryAddress() {
        return this.treasuryWallet ? this.treasuryWallet.address : null;
    }

    /**
     * Get the treasury wallet balance in wei.
     * @returns {Promise<string>} Balance in wei
     */
    async getTreasuryBalance() {
        await this.initialize();
        if (!this.treasuryWallet) {
            throw new Error('EVM_TREASURY_PRIVATE_KEY is not set');
        }
        const balance = await this.provider.getBalance(this.treasuryWallet.address);
        return balance.toString();
    }

    /**
     * Transfer native ETH (wei) from treasury to a recipient (for reward distribution).
     * Requires EVM_TREASURY_PRIVATE_KEY environment variable.
     * @param {string} toAddress - Recipient EVM wallet address (0x...)
     * @param {string|bigint|number} weiAmount - Amount in wei
     * @returns {Promise<string>} Transaction hash
     */
    async payTraderFeeClaim(toAddress, weiAmount) {
        await this.initialize();
        
        if (!this.treasuryWallet) {
            throw new Error('EVM_TREASURY_PRIVATE_KEY is not set; cannot pay trader fee claims');
        }

        // Validate address
        if (!ethers.utils.isAddress(toAddress)) {
            throw new Error(`Invalid EVM address: ${toAddress}`);
        }

        const amount = typeof weiAmount === 'bigint' 
            ? weiAmount 
            : BigInt(String(weiAmount));
        
        if (amount <= 0n) {
            throw new Error('Claim amount must be positive');
        }

        // Check treasury balance
        const balance = await this.provider.getBalance(this.treasuryWallet.address);
        if (balance.lt(ethers.BigNumber.from(amount.toString()))) {
            throw new Error(`Insufficient treasury balance: ${balance.toString()} wei < ${amount.toString()} wei`);
        }

        // Send transaction
        const tx = await this.treasuryWallet.sendTransaction({
            to: toAddress,
            value: ethers.BigNumber.from(amount.toString())
        });

        // Wait for confirmation
        const receipt = await tx.wait(1);
        
        console.log(`✓ EVM reward paid: ${ethers.utils.formatEther(amount.toString())} ETH to ${toAddress}`);
        console.log(`  TX: ${receipt.transactionHash}`);

        return receipt.transactionHash;
    }

    /**
     * Pay multiple recipients in batch (for efficiency).
     * @param {Array<{address: string, amount: string|bigint}>} recipients - Array of {address, amount} objects
     * @returns {Promise<Array<{address: string, txHash: string, success: boolean, error?: string}>>}
     */
    async payMultipleRecipients(recipients) {
        await this.initialize();
        
        if (!this.treasuryWallet) {
            throw new Error('EVM_TREASURY_PRIVATE_KEY is not set; cannot pay trader fee claims');
        }

        const results = [];
        
        for (const { address, amount } of recipients) {
            try {
                const txHash = await this.payTraderFeeClaim(address, amount);
                results.push({ address, txHash, success: true });
            } catch (error) {
                console.error(`✗ Failed to pay ${address}:`, error.message);
                results.push({ address, txHash: null, success: false, error: error.message });
            }
        }

        return results;
    }

    /**
     * Get current gas price.
     * @returns {Promise<string>} Gas price in wei
     */
    async getGasPrice() {
        await this.initialize();
        const gasPrice = await this.provider.getGasPrice();
        return gasPrice.toString();
    }

    /**
     * Estimate gas for an ETH transfer.
     * @param {string} toAddress - Recipient address
     * @param {string} amount - Amount in wei
     * @returns {Promise<string>} Estimated gas
     */
    async estimateTransferGas(toAddress, amount) {
        await this.initialize();
        const estimate = await this.provider.estimateGas({
            to: toAddress,
            value: ethers.BigNumber.from(amount)
        });
        return estimate.toString();
    }
}

module.exports = new EvmService();
