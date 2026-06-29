require('dotenv').config()

// Initial LP values from environment variables
// virtual_eth_lp = 0.01 * (10 ** 18) ETH
// Since we store values as strings and use BigInt for calculations, we store the value directly
// The user can set VIRTUAL_ETH_LP_INITIAL to represent 0.01 * (10 ** 18) in their preferred format
// Default: '10' (can be interpreted as 0.01 * 10^-18 ETH in a scaled format)
const VIRTUAL_ETH_LP_INITIAL = process.env.VIRTUAL_ETH_LP_INITIAL || '700000000000000000'; // 0.01 * (10 ** 18)
const VIRTUAL_TOKEN_LP_INITIAL = process.env.VIRTUAL_TOKEN_LP_INITIAL || '1073000000000000000000000000'; // 1073 * 1e24
const REAL_ETH_LP_INITIAL = process.env.REAL_ETH_LP_INITIAL || '0';
const REAL_TOKEN_LP_INITIAL = process.env.REAL_TOKEN_LP_INITIAL || '1000000000000000000000000000'; // 2 * 1e26
const BONDING_LIMIT = process.env.BONDING_LIMIT || '200000000000000000'; // Value in wei - when real_eth_lp >= this, lp_created = true

module.exports = {
    netId: Number(process.env.NET_ID) || 8453, // default to Base mainnet (set NET_ID for other chains)
    httpRpcUrl: process.env.HTTP_RPC_URL,
    wsRpcUrl: process.env.WS_RPC_URL,
    oracleRpcUrl: process.env.ORACLE_RPC_URL,
    privateKey: process.env.PRIVATE_KEY,
    contractAddr: process.env.CONTRACT_ADDRESS,
    // Block the Factory contract was deployed at. Factory catch-up never scans before this,
    // so a fresh/empty database doesn't trigger a scan from block 1 across the whole chain.
    factoryDeployBlock: Number(process.env.FACTORY_DEPLOY_BLOCK) || 0,
    // Solana: RPC and treasury (contract owner) key for reward distribution
    solanaRpcUrl: process.env.SOLANA_RPC_URL,
    solanaTreasuryPrivateKey: process.env.SOLANA_TREASURY_PRIVATE_KEY, // JSON array format e.g. [1,2,...]
    gasLimits: {
        ['withdraw']: 500000,
    },
    minimumBalance: '1000000',
    // Bonding curve LP configuration
    virtualEthLpInitial: VIRTUAL_ETH_LP_INITIAL,
    virtualTokenLpInitial: VIRTUAL_TOKEN_LP_INITIAL,
    realEthLpInitial: REAL_ETH_LP_INITIAL,
    realTokenLpInitial: REAL_TOKEN_LP_INITIAL,
    bondingLimit: BONDING_LIMIT,
}