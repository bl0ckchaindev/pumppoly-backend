const { Connection, PublicKey, Keypair, Transaction, SystemProgram, sendAndConfirmTransaction, SYSVAR_RENT_PUBKEY } = require('@solana/web3.js');
const { Program, AnchorProvider, Wallet, BN } = require('@coral-xyz/anchor');
const { 
    TOKEN_PROGRAM_ID, 
    ASSOCIATED_TOKEN_PROGRAM_ID, 
    getAssociatedTokenAddressSync,
    createAssociatedTokenAccountIdempotentInstruction
} = require('@solana/spl-token');
const path = require('path');
const IDL = require(path.join(__dirname, '../idl/fomo.json'));

const PROGRAM_ID = new PublicKey(IDL.address);
const GLOBAL_CONFIG_SEED = 'global_config';
const BONDING_CURVE_SEED = 'bonding_curve';
const BONDING_CURVE_AUTHORITY_SEED = 'bonding_curve_authority';
const CREATOR_VAULT_SEED = 'creator_vault';
const FEE_AUTHORITY_SEED = 'fee_authority';
const NATIVE_MINT = new PublicKey('So11111111111111111111111111111111111111112');
const METADATA_PROGRAM_ID = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');

class SolanaService {
    constructor() {
        this.connection = null;
        this.program = null;
        this.provider = null;
        this.treasuryKeypair = null;
    }

    /**
     * Initialize connection and program
     */
    async initialize() {
        const rpcUrl = process.env.SOLANA_RPC_URL;
        this.connection = new Connection(rpcUrl, 'confirmed');
        
        // Treasury/owner keypair (contract owner): for claim_protocol_fee and distributing rewards
        const treasuryKey = process.env.SOLANA_TREASURY_PRIVATE_KEY;
        if (treasuryKey && treasuryKey.trim() !== '' && treasuryKey !== '[]') {
            try {
                const secret = JSON.parse(treasuryKey);
                if (Array.isArray(secret) && secret.length === 64) {
                    this.treasuryKeypair = Keypair.fromSecretKey(Uint8Array.from(secret));
                } else {
                    console.warn('SOLANA_TREASURY_PRIVATE_KEY: expected JSON array of 64 numbers');
                }
            } catch (e) {
                try {
                    const bs58 = require('bs58');
                    this.treasuryKeypair = Keypair.fromSecretKey(bs58.decode(treasuryKey));
                } catch (e2) {
                    console.warn('SOLANA_TREASURY_PRIVATE_KEY invalid (use base58 or JSON array)');
                }
            }
        }

        // Create provider (wallet will be provided by caller)
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
        
        this.program = new Program(IDL, this.provider);
    }

    /**
     * Get bonding curve PDA
     */
    getBondingCurvePDA(baseMint) {
        const [pda] = PublicKey.findProgramAddressSync(
            [Buffer.from(BONDING_CURVE_SEED), new PublicKey(baseMint).toBuffer()],
            PROGRAM_ID
        );
        return pda;
    }

    /**
     * Get bonding curve authority PDA
     */
    getBondingCurveAuthorityPDA(baseMint) {
        const [pda] = PublicKey.findProgramAddressSync(
            [Buffer.from(BONDING_CURVE_AUTHORITY_SEED), new PublicKey(baseMint).toBuffer()],
            PROGRAM_ID
        );
        return pda;
    }

    /**
     * Get global config PDA
     */
    getGlobalConfigPDA() {
        const [pda] = PublicKey.findProgramAddressSync(
            [Buffer.from(GLOBAL_CONFIG_SEED)],
            PROGRAM_ID
        );
        return pda;
    }

    /**
     * Get creator vault PDA
     */
    getCreatorVaultPDA(creator) {
        const [pda] = PublicKey.findProgramAddressSync(
            [Buffer.from(CREATOR_VAULT_SEED), new PublicKey(creator).toBuffer()],
            PROGRAM_ID
        );
        return pda;
    }

    /**
     * Get fee authority PDA
     */
    getFeeAuthorityPDA() {
        const [pda] = PublicKey.findProgramAddressSync(
            [Buffer.from(FEE_AUTHORITY_SEED)],
            PROGRAM_ID
        );
        return pda;
    }

    /**
     * Get metadata PDA
     */
    getMetadataPDA(mint) {
        const [pda] = PublicKey.findProgramAddressSync(
            [
                Buffer.from('metadata'),
                METADATA_PROGRAM_ID.toBuffer(),
                new PublicKey(mint).toBuffer()
            ],
            METADATA_PROGRAM_ID
        );
        return pda;
    }

    /**
     * Create token transaction
     * @deprecated According to architecture, backend should NOT build transactions.
     * Frontend should build transactions directly. This method is kept for reference only.
     */
    async createTokenTransaction(wallet, args) {
        await this.initialize();
        
        const creator = wallet.publicKey;
        const baseMint = Keypair.generate();
        const bondingCurveAuthority = this.getBondingCurveAuthorityPDA(baseMint.publicKey);
        const bondingCurve = this.getBondingCurvePDA(baseMint.publicKey);
        const globalConfig = this.getGlobalConfigPDA();
        const creatorVault = this.getCreatorVaultPDA(creator);
        const feeAuthority = this.getFeeAuthorityPDA();
        const metadata = this.getMetadataPDA(baseMint.publicKey);

        // Get associated token accounts
        const baseVault = getAssociatedTokenAddressSync(
            baseMint.publicKey,
            bondingCurveAuthority,
            true
        );
        
        const quoteVault = getAssociatedTokenAddressSync(
            NATIVE_MINT,
            bondingCurveAuthority,
            true
        );

        const creatorQuoteAccount = getAssociatedTokenAddressSync(
            NATIVE_MINT,
            creatorVault,
            true
        );

        const feeQuoteAccount = getAssociatedTokenAddressSync(
            NATIVE_MINT,
            feeAuthority,
            true
        );

        const tx = await this.program.methods
            .createToken({
                name: args.name,
                symbol: args.symbol,
                uri: args.uri,
                openTime: new BN(args.openTime || Math.floor(Date.now() / 1000))
            })
            .accounts({
                creator: creator,
                globalConfig: globalConfig,
                baseMint: baseMint.publicKey,
                quoteMint: NATIVE_MINT,
                bondingCurveAuthority: bondingCurveAuthority,
                bondingCurve: bondingCurve,
                baseVault: baseVault,
                quoteVault: quoteVault,
                creatorVault: creatorVault,
                creatorQuoteAccount: creatorQuoteAccount,
                feeAuthority: feeAuthority,
                feeQuoteAccount: feeQuoteAccount,
                metadata: metadata,
                metadataProgram: METADATA_PROGRAM_ID,
                tokenProgram: TOKEN_PROGRAM_ID,
                associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
                systemProgram: SystemProgram.programId,
                rent: null
            })
            .signers([baseMint])
            .transaction();

        return { transaction: tx, baseMint: baseMint.publicKey.toString() };
    }

    /**
     * Buy tokens transaction
     * @deprecated According to architecture, backend should NOT build transactions.
     * Frontend should build transactions directly. This method is kept for reference only.
     */
    async buyTokensTransaction(wallet, baseMint, args) {
        await this.initialize();
        
        const buyer = wallet.publicKey;
        const baseMintPubkey = new PublicKey(baseMint);
        const bondingCurve = this.getBondingCurvePDA(baseMintPubkey);
        const bondingCurveAuthority = this.getBondingCurveAuthorityPDA(baseMintPubkey);
        const globalConfig = this.getGlobalConfigPDA();
        
        // Get bonding curve account to find owner
        const bondingCurveAccount = await this.program.account.bondingCurve.fetch(bondingCurve);
        const creatorVault = this.getCreatorVaultPDA(bondingCurveAccount.owner);
        const feeAuthority = this.getFeeAuthorityPDA();

        const baseVault = getAssociatedTokenAddressSync(
            baseMintPubkey,
            bondingCurveAuthority,
            true
        );

        const quoteVault = getAssociatedTokenAddressSync(
            NATIVE_MINT,
            bondingCurveAuthority,
            true
        );

        const buyerTokenAccount = getAssociatedTokenAddressSync(
            baseMintPubkey,
            buyer,
            false
        );

        const creatorQuoteAccount = getAssociatedTokenAddressSync(
            NATIVE_MINT,
            creatorVault,
            true
        );

        const feeQuoteAccount = getAssociatedTokenAddressSync(
            NATIVE_MINT,
            feeAuthority,
            true
        );

        const tx = await this.program.methods
            .buy({
                baseAmount: new BN(args.baseAmount || 0),
                quoteAmount: new BN(args.quoteAmount || 0)
            })
            .accounts({
                buyer: buyer,
                globalConfig: globalConfig,
                bondingCurve: bondingCurve,
                bondingCurveAuthority: bondingCurveAuthority,
                baseMint: baseMintPubkey,
                quoteMint: NATIVE_MINT,
                baseVault: baseVault,
                quoteVault: quoteVault,
                buyerTokenAccount: buyerTokenAccount,
                creatorVault: creatorVault,
                creatorQuoteAccount: creatorQuoteAccount,
                feeAuthority: feeAuthority,
                feeQuoteAccount: feeQuoteAccount,
                tokenProgram: TOKEN_PROGRAM_ID,
                associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
                systemProgram: SystemProgram.programId,
                rent: null
            })
            .transaction();

        return tx;
    }

    /**
     * Sell tokens transaction
     * @deprecated According to architecture, backend should NOT build transactions.
     * Frontend should build transactions directly. This method is kept for reference only.
     */
    async sellTokensTransaction(wallet, baseMint, args) {
        await this.initialize();
        
        const seller = wallet.publicKey;
        const baseMintPubkey = new PublicKey(baseMint);
        const bondingCurve = this.getBondingCurvePDA(baseMintPubkey);
        const bondingCurveAuthority = this.getBondingCurveAuthorityPDA(baseMintPubkey);
        const globalConfig = this.getGlobalConfigPDA();
        
        // Get bonding curve account to find owner
        const bondingCurveAccount = await this.program.account.bondingCurve.fetch(bondingCurve);
        const creatorVault = this.getCreatorVaultPDA(bondingCurveAccount.owner);
        const feeAuthority = this.getFeeAuthorityPDA();

        const baseVault = getAssociatedTokenAddressSync(
            baseMintPubkey,
            bondingCurveAuthority,
            true
        );

        const quoteVault = getAssociatedTokenAddressSync(
            NATIVE_MINT,
            bondingCurveAuthority,
            true
        );

        const sellerBaseAccount = getAssociatedTokenAddressSync(
            baseMintPubkey,
            seller,
            false
        );

        const sellerQuoteAccount = getAssociatedTokenAddressSync(
            NATIVE_MINT,
            seller,
            false
        );

        const creatorQuoteAccount = getAssociatedTokenAddressSync(
            NATIVE_MINT,
            creatorVault,
            true
        );

        const feeQuoteAccount = getAssociatedTokenAddressSync(
            NATIVE_MINT,
            feeAuthority,
            true
        );

        const tx = await this.program.methods
            .sell({
                baseAmount: new BN(args.baseAmount || 0),
                quoteAmount: new BN(args.quoteAmount || 0)
            })
            .accounts({
                seller: seller,
                globalConfig: globalConfig,
                baseMint: baseMintPubkey,
                quoteMint: NATIVE_MINT,
                bondingCurve: bondingCurve,
                bondingCurveAuthority: bondingCurveAuthority,
                baseVault: baseVault,
                quoteVault: quoteVault,
                sellerBaseAccount: sellerBaseAccount,
                sellerQuoteAccount: sellerQuoteAccount,
                creatorVault: creatorVault,
                creatorQuoteAccount: creatorQuoteAccount,
                feeAuthority: feeAuthority,
                feeQuoteAccount: feeQuoteAccount,
                tokenProgram: TOKEN_PROGRAM_ID,
                associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
                systemProgram: SystemProgram.programId
            })
            .transaction();

        return tx;
    }

    /**
     * Migrate token transaction
     * @deprecated According to architecture, backend should NOT build transactions.
     * Frontend should build transactions directly. This method is kept for reference only.
     */
    async migrateTokenTransaction(wallet, baseMint) {
        await this.initialize();
        
        const payer = wallet.publicKey;
        const baseMintPubkey = new PublicKey(baseMint);
        const bondingCurve = this.getBondingCurvePDA(baseMintPubkey);
        const bondingCurveAuthority = this.getBondingCurveAuthorityPDA(baseMintPubkey);
        const globalConfig = this.getGlobalConfigPDA();

        // This is a simplified version - full implementation would need CPMM program addresses
        // For now, return a placeholder
        throw new Error('Migrate functionality requires CPMM program integration');
    }

    /**
     * Get bonding curve data
     */
    async getBondingCurve(baseMint) {
        await this.initialize();
        
        const bondingCurve = this.getBondingCurvePDA(new PublicKey(baseMint));
        
        try {
            const account = await this.program.account.bondingCurve.fetch(bondingCurve);
            return {
                owner: account.owner.toString(),
                openTime: account.openTime.toNumber(),
                realBaseReserves: account.realBaseReserves.toNumber(),
                virtualBaseReserves: account.virtualBaseReserves.toNumber(),
                realQuoteReserves: account.realQuoteReserves.toNumber(),
                virtualQuoteReserves: account.virtualQuoteReserves.toNumber(),
                totalSupply: account.totalSupply.toNumber(),
                complete: account.complete
            };
        } catch (error) {
            return null;
        }
    }

    /**
     * Claim protocol fees from the fee vault into the owner's WSOL ATA.
     * Owner (SOLANA_TREASURY_PRIVATE_KEY) must be the contract owner.
     * @returns {Promise<string>} Transaction signature
     */
    async claimProtocolFee() {
        await this.initialize();
        if (!this.treasuryKeypair) {
            throw new Error('SOLANA_TREASURY_PRIVATE_KEY is not set; cannot claim protocol fee');
        }
        const globalConfig = this.getGlobalConfigPDA();
        const feeAuthority = this.getFeeAuthorityPDA();
        const feeQuoteAccount = getAssociatedTokenAddressSync(
            NATIVE_MINT,
            feeAuthority,
            true
        );
        const ownerQuoteAccount = getAssociatedTokenAddressSync(
            NATIVE_MINT,
            this.treasuryKeypair.publicKey,
            false
        );
        const tx = await this.program.methods
            .claimProtocolFee()
            .accountsStrict({
                owner: this.treasuryKeypair.publicKey,
                ownerQuoteAccount,
                globalConfig,
                feeAuthority,
                feeQuoteAccount,
                quoteMint: NATIVE_MINT,
                systemProgram: SystemProgram.programId,
                tokenProgram: TOKEN_PROGRAM_ID,
                associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
                rent: SYSVAR_RENT_PUBKEY
            })
            .signers([this.treasuryKeypair])
            .transaction();
        const sig = await sendAndConfirmTransaction(
            this.connection,
            tx,
            [this.treasuryKeypair],
            { commitment: 'confirmed', skipPreflight: false }
        );
        return sig;
    }

    /**
     * Ensure the owner's WSOL ATA exists (idempotent). Call after claimProtocolFee() so the source for payouts exists.
     * @returns {Promise<string|null>} Transaction signature, or null if skipped (e.g. no treasury key)
     */
    async ensureOwnerWsolAta() {
        await this.initialize();
        if (!this.treasuryKeypair) return null;
        const ownerQuoteAccount = getAssociatedTokenAddressSync(
            NATIVE_MINT,
            this.treasuryKeypair.publicKey,
            false
        );
        const tx = new Transaction().add(
            createAssociatedTokenAccountIdempotentInstruction(
                this.treasuryKeypair.publicKey,
                ownerQuoteAccount,
                this.treasuryKeypair.publicKey,
                NATIVE_MINT,
                TOKEN_PROGRAM_ID,
                ASSOCIATED_TOKEN_PROGRAM_ID
            )
        );
        const sig = await sendAndConfirmTransaction(
            this.connection,
            tx,
            [this.treasuryKeypair],
            { commitment: 'confirmed', skipPreflight: false }
        );
        return sig;
    }

    /**
     * Update global config on the Solana program (owner-only).
     * Requires SOLANA_TREASURY_PRIVATE_KEY (contract owner).
     * @param {Object} params
     * @param {number} params.protocolFeeBps - Protocol fee in basis points
     * @param {number} params.creatorFeeBps - Creator fee in basis points
     * @param {number} params.creatorMigrateFeeBps - Creator migration fee in basis points
     * @param {number} params.protocolMigrateFeeBps - Protocol migration fee in basis points
     * @param {string|number|bigint} params.realSolThreshold - Real SOL threshold in lamports (u64)
     * @returns {Promise<string>} Transaction signature
     */
    async updateGlobalConfig(params) {
        await this.initialize();
        if (!this.treasuryKeypair) {
            throw new Error('SOLANA_TREASURY_PRIVATE_KEY is not set; cannot update global config');
        }
        const owner = this.treasuryKeypair.publicKey;
        const globalConfig = this.getGlobalConfigPDA();
        const realSolThreshold = new BN(String(params.realSolThreshold ?? '0'));
        if (realSolThreshold.lt(0)) {
            throw new Error('realSolThreshold must be non-negative (lamports)');
        }
        const args = {
            owner,
            protocolFeeBps: Number(params.protocolFeeBps ?? 0),
            creatorFeeBps: Number(params.creatorFeeBps ?? 0),
            creatorMigrateFeeBps: Number(params.creatorMigrateFeeBps ?? 0),
            protocolMigrateFeeBps: Number(params.protocolMigrateFeeBps ?? 0),
            migrator: owner,
            realSolThreshold
        };
        const tx = await this.program.methods
            .updateConfig(args)
            .accounts({
                owner,
                globalConfig
            })
            .signers([this.treasuryKeypair])
            .transaction();
        const sig = await sendAndConfirmTransaction(
            this.connection,
            tx,
            [this.treasuryKeypair],
            { commitment: 'confirmed', skipPreflight: false }
        );
        return sig;
    }

    /**
     * Transfer native SOL (lamports) from owner/treasury to a trader (for reward distribution).
     * Requires SOLANA_TREASURY_PRIVATE_KEY (contract owner).
     * @param {string} toAddress - Recipient Solana wallet address (base58)
     * @param {string|bigint|number} lamports - Amount in lamports (native SOL)
     * @returns {Promise<string>} Transaction signature
     */
    async payTraderFeeClaim(toAddress, lamports) {
        await this.initialize();
        if (!this.treasuryKeypair) {
            throw new Error('SOLANA_TREASURY_PRIVATE_KEY is not set; cannot pay trader fee claims');
        }
        const toPubkey = new PublicKey(toAddress);
        const amount = typeof lamports === 'bigint' ? lamports : BigInt(String(lamports));
        if (amount <= 0n) {
            throw new Error('Claim amount must be positive');
        }
        const tx = new Transaction().add(
            SystemProgram.transfer({
                fromPubkey: this.treasuryKeypair.publicKey,
                toPubkey,
                lamports: Number(amount)
            })
        );
        const sig = await sendAndConfirmTransaction(
            this.connection,
            tx,
            [this.treasuryKeypair],
            { commitment: 'confirmed', skipPreflight: false }
        );
        return sig;
    }
}

module.exports = new SolanaService();

