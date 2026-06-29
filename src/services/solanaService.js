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
                complete: account.complete,
                liquidityLockSecs: account.liquidityLockSecs?.toNumber?.() ?? null,
                liquidityUnlockTs: account.liquidityUnlockTs?.toNumber?.() ?? null,
                poolLpMint: account.poolLpMint?.toString?.() ?? null,
                lpUnlocked: Boolean(account.lpUnlocked)
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
        // Protocol fees now go to the config's fee_recipient (separate from the owner/admin). Read it
        // from the on-chain config and derive its WSOL ATA (the instruction creates it on demand).
        const cfg = await this.program.account.globalConfig.fetch(globalConfig);
        const feeRecipient = cfg.feeRecipient;
        if (!feeRecipient) {
            throw new Error('Global config has no fee_recipient — deploy the updated program and refresh the IDL');
        }
        const recipientQuoteAccount = getAssociatedTokenAddressSync(NATIVE_MINT, feeRecipient, false);
        const tx = await this.program.methods
            .claimProtocolFee()
            .accountsStrict({
                owner: this.treasuryKeypair.publicKey,
                globalConfig,
                feeRecipient,
                recipientQuoteAccount,
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
     * Initialize the global config on the Solana program (one-time, owner-only).
     * The treasury wallet (SOLANA_TREASURY_PRIVATE_KEY) becomes the config owner + migrator.
     * Fails if the config is already initialized.
     * @param {Object} params
     * @param {number} params.protocolFeeBps - Protocol fee in basis points
     * @param {number} params.creatorFeeBps - Creator fee in basis points
     * @param {number} params.rewardFeeBps - Reward (trader) fee in basis points
     * @param {number} params.creatorMigrateFeeBps - Creator migration fee in basis points
     * @param {number} params.protocolMigrateFeeBps - Protocol migration fee in basis points
     * @param {string|number|bigint} params.realSolThreshold - Graduation threshold in lamports (u64)
     * @returns {Promise<string>} Transaction signature
     */
    async initializeConfig(params) {
        await this.initialize();
        if (!this.treasuryKeypair) {
            throw new Error('SOLANA_TREASURY_PRIVATE_KEY is not set; cannot initialize global config');
        }
        const owner = this.treasuryKeypair.publicKey;
        // fee_recipient: treasury that RECEIVES protocol fees (separate from the owner/admin).
        // Defaults to the owner if not supplied.
        const feeRecipient = params.feeRecipient ? new PublicKey(params.feeRecipient) : owner;
        const globalConfig = this.getGlobalConfigPDA();
        const feeAuthority = this.getFeeAuthorityPDA();
        // ATA owned by the fee_authority PDA (allowOwnerOffCurve = true)
        const feeWsolAccount = getAssociatedTokenAddressSync(NATIVE_MINT, feeAuthority, true);
        const realSolThreshold = new BN(String(params.realSolThreshold ?? '0'));
        if (realSolThreshold.lt(new BN(0))) {
            throw new Error('realSolThreshold must be non-negative (lamports)');
        }
        const args = {
            feeRecipient,
            protocolFeeBps: Number(params.protocolFeeBps ?? 0),
            creatorFeeBps: Number(params.creatorFeeBps ?? 0),
            rewardFeeBps: Number(params.rewardFeeBps ?? 0),
            creatorMigrateFeeBps: Number(params.creatorMigrateFeeBps ?? 0),
            protocolMigrateFeeBps: Number(params.protocolMigrateFeeBps ?? 0),
            realSolThreshold
        };
        const tx = await this.program.methods
            .initializeConfig(args)
            .accountsPartial({
                owner,
                globalConfig,
                nativeMint: NATIVE_MINT,
                feeAuthority,
                feeWsolAccount,
                tokenProgram: TOKEN_PROGRAM_ID,
                associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
                systemProgram: SystemProgram.programId
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
     * Update global config on the Solana program (owner-only).
     * Requires SOLANA_TREASURY_PRIVATE_KEY (contract owner).
     * @param {Object} params
     * @param {number} params.protocolFeeBps - Protocol fee in basis points
     * @param {number} params.creatorFeeBps - Creator fee in basis points
     * @param {number} params.rewardFeeBps - Reward (trader) fee in basis points
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
        const signer = this.treasuryKeypair.publicKey; // must be the CURRENT config owner
        const globalConfig = this.getGlobalConfigPDA();
        // Preserve the existing owner / migrator / fee_recipient unless explicitly overridden, so a
        // routine fee/threshold update never clobbers a handed-over role. (update_config writes all
        // three every call.) Pass owner/migrator/feeRecipient to perform the one-time role handover.
        const cfg = await this.program.account.globalConfig.fetch(globalConfig);
        const newOwner = params.owner ? new PublicKey(params.owner) : cfg.owner;
        const migrator = params.migrator ? new PublicKey(params.migrator) : cfg.migrator;
        const feeRecipient = params.feeRecipient ? new PublicKey(params.feeRecipient) : cfg.feeRecipient;
        const realSolThreshold = new BN(String(params.realSolThreshold ?? '0'));
        if (realSolThreshold.lt(0)) {
            throw new Error('realSolThreshold must be non-negative (lamports)');
        }
        const args = {
            owner: newOwner,
            feeRecipient,
            protocolFeeBps: Number(params.protocolFeeBps ?? 0),
            creatorFeeBps: Number(params.creatorFeeBps ?? 0),
            rewardFeeBps: Number(params.rewardFeeBps ?? 0),
            creatorMigrateFeeBps: Number(params.creatorMigrateFeeBps ?? 0),
            protocolMigrateFeeBps: Number(params.protocolMigrateFeeBps ?? 0),
            migrator,
            realSolThreshold
        };
        const tx = await this.program.methods
            .updateConfig(args)
            .accounts({
                owner: signer,
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

    /**
     * Build a reward-payout transfer that the USER pays gas for: treasury → user, with the user set
     * as fee payer. The treasury partial-signs (authorizing the funds); the user co-signs (as fee
     * payer) and submits, so the platform pays no network fee. Returns a base64 partially-signed tx.
     */
    async buildTraderFeeClaimTx(toAddress, lamports) {
        await this.initialize();
        if (!this.treasuryKeypair) {
            throw new Error('SOLANA_TREASURY_PRIVATE_KEY is not set; cannot build claim transaction');
        }
        const toPubkey = new PublicKey(toAddress);
        const amount = typeof lamports === 'bigint' ? lamports : BigInt(String(lamports));
        if (amount <= 0n) throw new Error('Claim amount must be positive');

        const tx = new Transaction().add(
            SystemProgram.transfer({
                fromPubkey: this.treasuryKeypair.publicKey,
                toPubkey,
                lamports: Number(amount)
            })
        );
        const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash('confirmed');
        tx.recentBlockhash = blockhash;
        tx.feePayer = toPubkey;                  // user pays the network fee
        tx.partialSign(this.treasuryKeypair);     // treasury authorizes the transfer (no fee, not fee payer)

        const serialized = tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
        return { transaction: serialized, blockhash, lastValidBlockHeight, amount: amount.toString() };
    }

    /**
     * Verify a confirmed transaction `signature` is exactly the treasury → `toAddress` System
     * transfer of `lamports` (the expected reward payout). Returns false if the tx isn't confirmed
     * yet, errored, or doesn't match — so a claim can't be finalized with an unrelated signature.
     */
    async verifyClaimPayout(signature, toAddress, lamports) {
        await this.initialize();
        if (!this.treasuryKeypair) return false;
        const tx = await this.connection.getParsedTransaction(signature, {
            commitment: 'confirmed',
            maxSupportedTransactionVersion: 0,
        });
        if (!tx || (tx.meta && tx.meta.err)) return false;
        const treasuryStr = this.treasuryKeypair.publicKey.toBase58();
        const toStr = new PublicKey(toAddress).toBase58();
        const target = BigInt(String(lamports));
        const instructions = (tx.transaction && tx.transaction.message && tx.transaction.message.instructions) || [];
        for (const ix of instructions) {
            const p = ix.parsed;
            if (p && p.type === 'transfer' && ix.program === 'system' && p.info) {
                if (
                    p.info.source === treasuryStr &&
                    p.info.destination === toStr &&
                    BigInt(String(p.info.lamports)) === target
                ) {
                    return true;
                }
            }
        }
        return false;
    }

    /**
     * Reconciliation helper: find a confirmed treasury → `toAddress` transfer of `lamports` that
     * landed at/after `sinceUnixSeconds`. Detects a payout the user never reported (built + submitted
     * the claim tx but skipped /confirm) so an expired lock is never released for a claim that already
     * paid out (double-claim protection). Returns the matching signature, or null.
     */
    async findTreasuryPayout(toAddress, lamports, sinceUnixSeconds) {
        await this.initialize();
        if (!this.treasuryKeypair) return null;
        const treasury = this.treasuryKeypair.publicKey;
        const sigs = await this.connection.getSignaturesForAddress(treasury, { limit: 200 });
        for (const s of sigs) {
            if (s.err) continue;
            // List is newest-first; stop once we pass below the window (small skew margin).
            if (sinceUnixSeconds && s.blockTime && s.blockTime < sinceUnixSeconds - 10) break;
            const ok = await this.verifyClaimPayout(s.signature, toAddress, lamports).catch(() => false);
            if (ok) return s.signature;
        }
        return null;
    }
}

module.exports = new SolanaService();

