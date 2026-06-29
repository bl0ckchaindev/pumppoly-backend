/**
 * Token registration route - allows frontend to register EVM tokens after creation.
 * This ensures tokens appear in Supabase and on the frontend even when the backend
 * event listener misses the TokenCreated event (e.g. different RPC or chain config).
 */
const express = require('express');
const router = express.Router();
const nacl = require('tweetnacl');
const { PublicKey } = require('@solana/web3.js');
const tokenService = require('../services/tokenService');
const supabaseService = require('../services/supabaseService');

// Canonical message a creator signs to authorize a token media update. MUST match the frontend
// `tokenMediaMessage` byte-for-byte.
function tokenMediaMessage(chain, token, logo, banner) {
  return `PumpPoly set token media\nchain: ${chain}\ntoken: ${token}\nlogo: ${logo}\nbanner: ${banner}`;
}

function verifySolanaSignature(message, signatureB64, publicKeyB58) {
  try {
    const msg = new Uint8Array(Buffer.from(message, 'utf8'));
    const sig = new Uint8Array(Buffer.from(signatureB64, 'base64'));
    const pub = new PublicKey(publicKeyB58).toBytes();
    return sig.length === 64 && nacl.sign.detached.verify(msg, sig, pub);
  } catch (_) {
    return false;
  }
}
const { getEventListener } = require('../eventListener');
const { virtualEthLpInitial, virtualTokenLpInitial, realEthLpInitial, realTokenLpInitial, bondingLimit, netId } = require('../config');
const { chainIdToSlug, CHAIN_ID_TO_SLUG, getEvmChainSlug } = require('../lib/chainUtils');

const SUPPORTED_EVM_CHAIN_IDS = new Set(Object.keys(CHAIN_ID_TO_SLUG).map(Number));

// EVM address validation
function isValidEvmAddress(addr) {
  return typeof addr === 'string' && /^0x[a-fA-F0-9]{40}$/.test(addr);
}

function isValidTxHash(txHash) {
  return typeof txHash === 'string' && /^0x[a-fA-F0-9]{64}$/.test(txHash);
}

/**
 * POST /tokens/register
 * Register an EVM token after on-chain creation.
 * Body: { chainId, chain?, transactionHash, tokenAddress, bondingCurveAddress, creator, name, symbol, description?, website?, twitter?, telegram?, blockNumber?, timestamp?, logoUrl?, bannerUrl? }
 * Optional `chain` slug overrides mapping from chainId (e.g. polygon, bsc, base).
 */
router.post('/tokens/register', async (req, res) => {
  try {
    const {
      chainId,
      chain: chainBody,
      transactionHash,
      tokenAddress,
      bondingCurveAddress,
      creator,
      name,
      symbol,
      description,
      website,
      twitter,
      telegram,
      blockNumber,
      timestamp,
      logoUrl,
      bannerUrl
    } = req.body;

    const chainIdNum = chainId != null ? Number(chainId) : NaN;
    if (!Number.isFinite(chainIdNum) || !SUPPORTED_EVM_CHAIN_IDS.has(chainIdNum)) {
      return res.status(400).json({
        success: false,
        error: `Invalid or unsupported chainId (supported: ${[...SUPPORTED_EVM_CHAIN_IDS].join(', ')})`
      });
    }
    if (!transactionHash || !isValidTxHash(transactionHash)) {
      return res.status(400).json({ success: false, error: 'Valid transactionHash is required' });
    }
    if (!tokenAddress || !isValidEvmAddress(tokenAddress)) {
      return res.status(400).json({ success: false, error: 'Valid tokenAddress is required' });
    }
    if (!bondingCurveAddress || !isValidEvmAddress(bondingCurveAddress)) {
      return res.status(400).json({ success: false, error: 'Valid bondingCurveAddress is required' });
    }
    if (!creator || !isValidEvmAddress(creator)) {
      return res.status(400).json({ success: false, error: 'Valid creator is required' });
    }
    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ success: false, error: 'name is required' });
    }
    if (!symbol || typeof symbol !== 'string' || !symbol.trim()) {
      return res.status(400).json({ success: false, error: 'symbol is required' });
    }

    // ── Verify the on-chain factory event (not just the tx-hash format) ──────────────────────────
    // Confirm the transaction exists, succeeded, and emitted a matching TokenCreated event from THIS
    // backend's factory, so callers can't register spoofed/fake tokens. On-chain values are
    // authoritative. (If this is rejected, the event listener still indexes real tokens on its own.)
    if (chainIdNum !== netId) {
      return res.status(400).json({
        success: false,
        error: `chainId ${chainIdNum} does not match this indexer's chain (${netId}); cannot verify on-chain`
      });
    }

    let evt;
    let verifiedBlock = 0;
    try {
      const listener = getEventListener();
      if (!listener.provider || !listener.factoryContract) await listener.initialize();

      const receipt = await listener.provider.getTransactionReceipt(transactionHash);
      if (!receipt) {
        return res.status(400).json({ success: false, error: 'Transaction not found or not yet mined; retry shortly' });
      }
      if (receipt.status !== 1) {
        return res.status(400).json({ success: false, error: 'Transaction failed on-chain' });
      }

      const factoryAddr = String(listener.factoryContract.address || listener.factoryAddress || '').toLowerCase();
      for (const log of (receipt.logs || [])) {
        if (String(log.address).toLowerCase() !== factoryAddr) continue;
        let parsed;
        try { parsed = listener.factoryContract.interface.parseLog(log); } catch (_) { continue; }
        if (parsed && parsed.name === 'TokenCreated') { evt = parsed; break; }
      }
      if (!evt) {
        return res.status(400).json({ success: false, error: 'No matching TokenCreated event from the factory in this transaction' });
      }
      verifiedBlock = Number(receipt.blockNumber) || 0;
    } catch (e) {
      console.error('POST /tokens/register on-chain verification error:', e.message);
      return res.status(502).json({ success: false, error: 'Failed to verify the transaction on-chain; retry shortly' });
    }

    // On-chain values are the source of truth; reject if the request contradicts them.
    const evToken = String(evt.args.tokenAddress).toLowerCase();
    const evCurve = String(evt.args.bondingCurveAddress).toLowerCase();
    const evCreator = String(evt.args.creator).toLowerCase();
    if (
      evToken !== tokenAddress.toLowerCase() ||
      evCurve !== bondingCurveAddress.toLowerCase() ||
      evCreator !== creator.toLowerCase()
    ) {
      return res.status(400).json({
        success: false,
        error: 'Request does not match the on-chain TokenCreated event (token/bondingCurve/creator mismatch)'
      });
    }

    const virtualEthLp = virtualEthLpInitial || '10000000000000000';
    const virtualTokenLp = virtualTokenLpInitial || '1073000000000000000000000';
    const realEthLp = realEthLpInitial || '0';
    const realTokenLp = realTokenLpInitial || '200000000000000000000000000';
    const k = (BigInt(virtualEthLp) * BigInt(virtualTokenLp)).toString();
    // Block number + timestamp come from the verified receipt/event (authoritative), with the
    // request body only as a fallback.
    const blockNum = verifiedBlock || (blockNumber != null ? Number(blockNumber) : 0);
    const ts = evt.args.timestamp
      ? Number(evt.args.timestamp.toString())
      : (timestamp != null ? Number(timestamp) : Math.floor(Date.now() / 1000));

    const chainSlug =
      typeof chainBody === 'string' && chainBody.trim()
        ? chainBody.trim().toLowerCase()
        : chainIdToSlug(chainIdNum);

    const tokenData = {
      chain: chainSlug,
      tokenAddress: evToken,
      bondingCurveAddress: evCurve,
      creator: evCreator,
      name: String(evt.args.name ?? name ?? '').trim(),
      symbol: String(evt.args.symbol ?? symbol ?? '').trim(),
      description: String(evt.args.description ?? description ?? ''),
      website: String(evt.args.website ?? website ?? ''),
      twitter: String(evt.args.twitter ?? twitter ?? ''),
      telegram: String(evt.args.telegram ?? telegram ?? ''),
      discord: '',
      logoUrl: String(logoUrl || ''),
      bannerUrl: String(bannerUrl || ''),
      totalSupply: '1000000000000000000000000000',
      decimals: 18,
      transactionHash: transactionHash.toLowerCase(),
      blockNumber: blockNum,
      timestamp: ts,
      initialPrice: '0',
      feeAmount: '0',
      virtualEthLp: String(virtualEthLp),
      virtualTokenLp: String(virtualTokenLp),
      realEthLp: String(realEthLp),
      realTokenLp: String(realTokenLp),
      k: String(k),
      tokenStartPrice: '0',
      volume: '0',
      lpCreated: BigInt(realEthLp) >= BigInt(bondingLimit || '0')
    };

    const result = await tokenService.createToken(tokenData);

    return res.status(200).json({
      success: true,
      isNew: result.isNew,
      token: result.token,
      bondingCurve: result.bondingCurve
    });
  } catch (err) {
    console.error('POST /tokens/register error:', err);
    const status = err.message && (err.message.includes('duplicate') || err.message.includes('already exists')) ? 409 : 500;
    return res.status(status).json({
      success: false,
      error: err.message || 'Failed to register token'
    });
  }
});

/**
 * POST /tokens/media
 * Set a token's logo/banner after creation, for chains where media isn't carried on-chain
 * (Solana banner). Locked down: the caller must sign `tokenMediaMessage(...)` with the wallet that
 * is the token's on-chain creator. The signature binds the exact logo/banner values.
 * Body: { chain, tokenAddress, logoUrl, bannerUrl, publicKey, signature }
 * Returns { success, found } — `found:false` means the token row isn't indexed yet (caller retries).
 */
router.post('/tokens/media', async (req, res) => {
  try {
    const { chain, tokenAddress, logoUrl = '', bannerUrl = '', publicKey, signature } = req.body || {};
    if (!chain || !tokenAddress) {
      return res.status(400).json({ success: false, error: 'chain and tokenAddress are required' });
    }
    // Only Solana uses this endpoint (EVM media is set at registration time). ed25519 verification.
    if (chain !== 'solana') {
      return res.status(400).json({ success: false, error: 'Unsupported chain for media update' });
    }
    if (!publicKey || !signature) {
      return res.status(401).json({ success: false, error: 'Missing signature' });
    }

    const existing = await supabaseService.getTokenByAddress(tokenAddress, chain);
    if (!existing) {
      return res.status(200).json({ success: false, found: false });
    }

    // Write-once: media is immutable once stored. If the banner is already set, refuse to change it.
    // (Returned as 200 so the client's retry loop stops instead of treating it as a transient error.)
    const hasValue = (v) => typeof v === 'string' && v.trim() !== '';
    if (hasValue(existing.bannerUrl)) {
      return res.status(200).json({ success: false, found: true, locked: true, error: 'Token media already set' });
    }

    // Verify the signature is over the exact media values, by the token's creator.
    const message = tokenMediaMessage(chain, String(tokenAddress), String(logoUrl), String(bannerUrl));
    if (!verifySolanaSignature(message, signature, publicKey)) {
      return res.status(401).json({ success: false, error: 'Invalid signature' });
    }
    if (String(publicKey) !== String(existing.creator)) {
      return res.status(403).json({ success: false, error: 'Signer is not the token creator' });
    }

    // Only fill fields that aren't set yet (Solana logo is set on-chain at creation).
    const update = { bannerUrl: String(bannerUrl) };
    if (!hasValue(existing.logoUrl)) update.logoUrl = String(logoUrl);
    const token = await supabaseService.updateToken(tokenAddress, update, chain);
    return res.status(200).json({ success: true, found: true, token });
  } catch (err) {
    console.error('POST /tokens/media error:', err);
    return res.status(500).json({ success: false, error: err.message || 'Failed to set token media' });
  }
});

/**
 * POST /tokens/process-trade
 * Process an EVM trade from transaction hash. Frontend calls this after a successful
 * buy/sell swap so token_price_data is inserted for the chart (fallback when event
 * listener misses the trade).
 * Body: { transactionHash: string, bondingCurveAddress: string }
 */
router.post('/tokens/process-trade', async (req, res) => {
  try {
    const { transactionHash, bondingCurveAddress } = req.body || {};
    if (!transactionHash || !isValidTxHash(transactionHash)) {
      return res.status(400).json({
        success: false,
        error: 'Valid transactionHash is required'
      });
    }
    if (!bondingCurveAddress || !isValidEvmAddress(bondingCurveAddress)) {
      return res.status(400).json({
        success: false,
        error: 'Valid bondingCurveAddress is required'
      });
    }

    // Only process trades for a bonding curve we've indexed (created by the PumpPoly factory).
    // bonding_curves rows are only inserted from verified TokenCreated factory events, so existence
    // here is proof of factory origin — this blocks trade/fee events from arbitrary contracts.
    const tradeCurve = await supabaseService.getBondingCurveByAddress(bondingCurveAddress.toLowerCase(), getEvmChainSlug());
    if (!tradeCurve) {
      return res.status(400).json({
        success: false,
        error: 'Unknown bondingCurveAddress — not a registered PumpPoly bonding curve'
      });
    }

    const listener = getEventListener();
    const result = await listener.processTradeFromTxHash(transactionHash, bondingCurveAddress);

    if (!result.success) {
      return res.status(400).json({
        success: false,
        error: result.error || 'Failed to process trade'
      });
    }

    return res.status(200).json({
      success: true,
      processed: result.processed
    });
  } catch (err) {
    console.error('POST /tokens/process-trade error:', err);
    return res.status(500).json({
      success: false,
      error: err.message || 'Failed to process trade'
    });
  }
});

/**
 * POST /tokens/ensure-listening
 * Ensure the backend is listening to a bonding curve for trade events.
 * Frontend can call when token page loads so events are captured.
 * Body: { bondingCurveAddress: string }
 */
router.post('/tokens/ensure-listening', async (req, res) => {
  try {
    const { bondingCurveAddress } = req.body || {};
    if (!bondingCurveAddress || !isValidEvmAddress(bondingCurveAddress)) {
      return res.status(400).json({
        success: false,
        error: 'Valid bondingCurveAddress is required'
      });
    }

    // Only subscribe to a bonding curve we've indexed (created by the PumpPoly factory) — never an
    // arbitrary contract address.
    const listenCurve = await supabaseService.getBondingCurveByAddress(bondingCurveAddress.toLowerCase(), getEvmChainSlug());
    if (!listenCurve) {
      return res.status(400).json({
        success: false,
        error: 'Unknown bondingCurveAddress — not a registered PumpPoly bonding curve'
      });
    }

    await tokenService.ensureBondingCurveIsListened(bondingCurveAddress.toLowerCase());
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('POST /tokens/ensure-listening error:', err);
    return res.status(500).json({
      success: false,
      error: err.message || 'Failed to ensure listening'
    });
  }
});

module.exports = router;
