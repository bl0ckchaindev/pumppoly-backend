const crypto = require('crypto');

/**
 * Admin auth guard for sensitive operational endpoints (on-chain config changes, etc.).
 *
 * The caller must present the admin key via either:
 *   - header  `x-admin-key: <key>`
 *   - header  `Authorization: Bearer <key>`
 * matching `process.env.ADMIN_API_KEY`.
 *
 * Fail-closed: if ADMIN_API_KEY is not configured, the endpoint returns 503 (locked) rather
 * than being left open — a missing config can never silently expose admin actions.
 */
function timingSafeEqualStr(a, b) {
    const ab = Buffer.from(String(a));
    const bb = Buffer.from(String(b));
    if (ab.length !== bb.length) return false;
    return crypto.timingSafeEqual(ab, bb);
}

function adminAuth(req, res, next) {
    const expected = (process.env.ADMIN_API_KEY || '').trim();
    if (!expected) {
        return res.status(503).json({ error: 'Admin API is not configured (ADMIN_API_KEY not set)' });
    }
    const headerKey = req.headers['x-admin-key'];
    const authHeader = req.headers['authorization'] || '';
    const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    const provided = (headerKey || bearer || '').trim();
    if (!provided || !timingSafeEqualStr(provided, expected)) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
}

module.exports = adminAuth;
