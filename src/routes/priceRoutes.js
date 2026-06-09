const express = require('express');
const router = express.Router();
const fetch = require('node-fetch');

/**
 * Native-coin USD price proxy.
 *
 * The frontend used to call min-api.cryptocompare.com directly, but that endpoint no longer returns
 * CORS headers for browser origins (especially once rate-limited), so the request fails in the
 * console. Proxying it here fixes the CORS error (the browser only ever talks to our own API, which
 * already allows the app origin) and is cheaper: one cached server-side request is shared by every
 * visitor instead of each browser hammering cryptocompare.
 */

const TTL_MS = 60 * 1000; // serve a cached price for up to a minute
const cache = new Map(); // SYMBOL -> { usd, ts }

async function getUsd(symbol) {
    const now = Date.now();
    const hit = cache.get(symbol);
    if (hit && now - hit.ts < TTL_MS) return hit.usd;

    try {
        const url = `https://min-api.cryptocompare.com/data/price?fsym=${encodeURIComponent(symbol)}&tsyms=USD`;
        const res = await fetch(url, { timeout: 8000 });
        const data = await res.json();
        const usd = Number(data && data.USD);
        if (isFinite(usd) && usd > 0) {
            cache.set(symbol, { usd, ts: now });
            return usd;
        }
    } catch (err) {
        console.error(`[Price] ${symbol} fetch failed:`, err.message);
    }
    // On any failure fall back to the last good value (stale is better than 0 for a price display).
    return hit ? hit.usd : 0;
}

// GET /price?fsym=ETH  -> { "USD": 1234.56 }   (mirrors cryptocompare's response shape)
router.get('/price', async (req, res) => {
    const symbol = String(req.query.fsym || req.query.symbol || 'ETH').toUpperCase().slice(0, 8);
    const usd = await getUsd(symbol);
    res.set('Cache-Control', 'public, max-age=30');
    res.json({ USD: usd });
});

module.exports = router;
