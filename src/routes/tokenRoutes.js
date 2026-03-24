/**
 * Token registration route - allows frontend to register EVM tokens after creation.
 * This ensures tokens appear in Supabase and on the frontend even when the backend
 * event listener misses the TokenCreated event (e.g. different RPC or chain config).
 */
const express = require('express');
const router = express.Router();
const tokenService = require('../services/tokenService');
const { getEventListener } = require('../eventListener');
const { virtualEthLpInitial, virtualTokenLpInitial, realEthLpInitial, realTokenLpInitial, bondingLimit } = require('../config');

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
 * Body: { chainId, transactionHash, tokenAddress, bondingCurveAddress, creator, name, symbol, description?, website?, twitter?, telegram?, blockNumber?, timestamp?, logoUrl?, bannerUrl? }
 */
router.post('/tokens/register', async (req, res) => {
  try {
    const {
      chainId,
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

    if (!chainId || (chainId !== 11155111 && chainId !== 8453 && chainId !== 84532)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid or unsupported chainId (use 11155111 for Sepolia, 8453 for Base, 84532 for Base Sepolia)'
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

    const virtualEthLp = virtualEthLpInitial || '10000000000000000';
    const virtualTokenLp = virtualTokenLpInitial || '1073000000000000000000000';
    const realEthLp = realEthLpInitial || '0';
    const realTokenLp = realTokenLpInitial || '200000000000000000000000000';
    const k = (BigInt(virtualEthLp) * BigInt(virtualTokenLp)).toString();
    const blockNum = blockNumber != null ? Number(blockNumber) : 0;
    const ts = timestamp != null ? Number(timestamp) : Math.floor(Date.now() / 1000);

    const tokenData = {
      chain: 'evm',
      tokenAddress: tokenAddress.toLowerCase(),
      bondingCurveAddress: bondingCurveAddress.toLowerCase(),
      creator: creator.toLowerCase(),
      name: String(name || '').trim(),
      symbol: String(symbol || '').trim(),
      description: String(description || ''),
      website: String(website || ''),
      twitter: String(twitter || ''),
      telegram: String(telegram || ''),
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
