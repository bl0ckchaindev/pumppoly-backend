/**
 * On-chain holder balance indexer.
 *
 * Reads token balances directly from chain and stores them in the `token_holders` table:
 *   - EVM:    scans the ERC20 Transfer logs to discover involved wallets, then reads each
 *             wallet's absolute balanceOf (self-healing) and upserts it. Incremental per token.
 *   - Solana: enumerates all SPL token accounts of the mint (getParsedProgramAccounts), sums by
 *             owner, and replaces the holder set.
 *
 * The bonding curve / pool / zero / dead addresses are excluded so only real holders are stored.
 */
const ethers = require('ethers');
const { httpRpcUrl, contractAddr, factoryDeployBlock } = require('../config');
const supabaseService = require('./supabaseService');

const ERC20_ABI = [
  'event Transfer(address indexed from, address indexed to, uint256 value)',
  'function balanceOf(address owner) view returns (uint256)',
];

const ZERO = '0x0000000000000000000000000000000000000000';
const DEAD = '0x000000000000000000000000000000000000dead';

// Lazy Solana imports (kept out of the hot path for EVM-only deployments).
let _solWeb3 = null;
let _splToken = null;
function solWeb3() { return (_solWeb3 ||= require('@solana/web3.js')); }
function splToken() { return (_splToken ||= require('@solana/spl-token')); }
const TOKEN_PROGRAM_ID_STR = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

class HolderService {
  constructor() {
    this.evmProvider = null;
    this._evmLastBlock = new Map();   // `${chain}:${token}` -> last scanned block
    this._running = new Set();        // in-flight token keys (avoid overlapping syncs)
  }

  getEvmProvider() {
    if (!this.evmProvider) this.evmProvider = new ethers.providers.JsonRpcProvider(httpRpcUrl);
    return this.evmProvider;
  }

  // ── EVM ────────────────────────────────────────────────────────────────────
  /**
   * Incrementally index EVM holders for one token. Discovers wallets from new Transfer logs and
   * refreshes their absolute balances. First run (or after restart) scans from `fromBlockHint`.
   */
  async syncEvmHolders(tokenAddress, bondingCurveAddress, chain, fromBlockHint = 0) {
    const key = `${chain}:${String(tokenAddress).toLowerCase()}`;
    if (this._running.has(key)) return;
    this._running.add(key);
    try {
      const provider = this.getEvmProvider();
      const token = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
      const latest = await provider.getBlockNumber();
      const last = this._evmLastBlock.get(key);
      // Floor the first scan at the factory deploy block: token rows may have block_number 0
      // (frontend-registered), and a token can't have Transfers before the factory existed.
      const firstFrom = Math.max(Number(fromBlockHint) || 0, Number(factoryDeployBlock) || 0);
      const start = last != null ? last + 1 : firstFrom;
      if (start > latest) { this._evmLastBlock.set(key, latest); return; }

      const exclude = new Set([ZERO, DEAD, String(bondingCurveAddress || '').toLowerCase(), String(contractAddr || '').toLowerCase()]);
      const involved = new Set();
      const BATCH = 2000; // RPC eth_getLogs range cap
      for (let b = start; b <= latest; b += BATCH) {
        const to = Math.min(b + BATCH - 1, latest);
        try {
          const logs = await token.queryFilter(token.filters.Transfer(), b, to);
          for (const l of logs) {
            involved.add(String(l.args.from).toLowerCase());
            involved.add(String(l.args.to).toLowerCase());
          }
        } catch (e) {
          console.error(`[Holders] EVM getLogs ${tokenAddress} ${b}-${to}:`, e.message);
        }
      }

      const addrs = [...involved].filter((a) => a && !exclude.has(a));
      let refreshed = 0;
      for (const a of addrs) {
        try {
          const bal = await token.balanceOf(a);
          await supabaseService.upsertTokenHolder(chain, tokenAddress, a, bal.toString());
          refreshed++;
        } catch (e) { /* skip individual failures */ }
      }
      this._evmLastBlock.set(key, latest);
      if (refreshed) console.log(`[Holders] EVM ${tokenAddress} refreshed ${refreshed} holder(s)`);
    } catch (e) {
      console.error(`[Holders] syncEvmHolders ${tokenAddress}:`, e.message);
    } finally {
      this._running.delete(key);
    }
  }

  /** Quick refresh of specific EVM wallets (e.g. the trader right after a trade). */
  async refreshEvmAddresses(tokenAddress, bondingCurveAddress, chain, addresses = []) {
    try {
      const provider = this.getEvmProvider();
      const token = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
      const exclude = new Set([ZERO, DEAD, String(bondingCurveAddress || '').toLowerCase(), String(contractAddr || '').toLowerCase()]);
      for (const raw of addresses) {
        const a = String(raw || '').toLowerCase();
        if (!a || exclude.has(a)) continue;
        try {
          const bal = await token.balanceOf(a);
          await supabaseService.upsertTokenHolder(chain, tokenAddress, a, bal.toString());
        } catch (e) { /* skip */ }
      }
    } catch (e) {
      console.error('[Holders] refreshEvmAddresses:', e.message);
    }
  }

  // ── Solana ───────────────────────────────────────────────────────────────
  _solanaExcluded(mint) {
    const { PublicKey } = solWeb3();
    const PROGRAM_ID = new PublicKey(require('../idl/fomo.json').address);
    const mintPk = new PublicKey(mint);
    const ex = new Set();
    for (const seed of ['bonding_curve', 'bonding_curve_authority']) {
      const [pda] = PublicKey.findProgramAddressSync([Buffer.from(seed), mintPk.toBuffer()], PROGRAM_ID);
      ex.add(pda.toString());
    }
    return ex;
  }

  /** Full holder rebuild for a Solana mint via all SPL token accounts of the mint. */
  async syncSolanaHolders(mint, chain) {
    try {
      const { Connection, PublicKey } = solWeb3();
      const connection = new Connection(process.env.SOLANA_RPC_URL, 'confirmed');
      const accounts = await connection.getParsedProgramAccounts(new PublicKey(TOKEN_PROGRAM_ID_STR), {
        filters: [{ dataSize: 165 }, { memcmp: { offset: 0, bytes: mint } }],
      });
      const exclude = this._solanaExcluded(mint);
      const byOwner = new Map();
      for (const acc of accounts) {
        const info = acc.account?.data?.parsed?.info;
        if (!info || !info.owner) continue;
        if (exclude.has(info.owner)) continue;
        const amount = info.tokenAmount?.amount || '0';
        const prev = byOwner.get(info.owner);
        byOwner.set(info.owner, prev ? (BigInt(prev) + BigInt(amount)).toString() : amount);
      }
      const holders = [...byOwner.entries()]
        .filter(([, b]) => BigInt(b) > 0n)
        .map(([wallet, balance]) => ({ wallet, balance }));
      await supabaseService.replaceTokenHolders(chain, mint, holders);
      console.log(`[Holders] Solana ${mint} -> ${holders.length} holder(s)`);
    } catch (e) {
      console.error(`[Holders] syncSolanaHolders ${mint}:`, e.message);
    }
  }

  /** Quick refresh of one Solana wallet's balance (e.g. the trader after a trade). */
  async refreshSolanaAddress(mint, owner, chain) {
    try {
      const { Connection, PublicKey } = solWeb3();
      const { getAssociatedTokenAddressSync } = splToken();
      const connection = new Connection(process.env.SOLANA_RPC_URL, 'confirmed');
      const ata = getAssociatedTokenAddressSync(new PublicKey(mint), new PublicKey(owner));
      try {
        const bal = await connection.getTokenAccountBalance(ata);
        await supabaseService.upsertTokenHolder(chain, mint, owner, bal.value.amount);
      } catch {
        await supabaseService.deleteTokenHolder(chain, mint, owner);
      }
    } catch (e) {
      console.error('[Holders] refreshSolanaAddress:', e.message);
    }
  }
}

module.exports = new HolderService();
