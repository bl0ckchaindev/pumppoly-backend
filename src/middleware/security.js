const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const path = require('path');

// Rate limiting configurations
const generalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 500, // Limit each IP to 500 requests per windowMs (increased for app's needs)
    message: 'Too many requests from this IP, please try again later.',
    standardHeaders: true,
    legacyHeaders: false,
});

const strictLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 20, // Limit each IP to 20 requests per windowMs
    message: 'Too many requests from this IP, please try again later.',
    standardHeaders: true,
    legacyHeaders: false,
});

const uploadLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 hour
    max: 20, // Limit each IP to 20 uploads per hour
    message: 'Too many uploads from this IP, please try again later.',
    standardHeaders: true,
    legacyHeaders: false,
});

// Fee endpoints limiter - more lenient for frequent polling
const feeLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 30, // 30 requests per minute for fee-related endpoints
    message: 'Too many fee requests, please try again later.',
    standardHeaders: true,
    legacyHeaders: false,
});

// Security headers middleware
const securityHeaders = helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            styleSrc: ["'self'", "'unsafe-inline'"],
            scriptSrc: ["'self'"],
            imgSrc: ["'self'", "data:", "https:"],
        },
    },
    crossOriginEmbedderPolicy: false,
});

// File path validation to prevent path traversal
function validateFilePath(filePath) {
    // Resolve to absolute path
    const resolvedPath = path.resolve(filePath);
    const uploadsDir = path.resolve(__dirname, '../uploads');
    
    // Check if resolved path is within uploads directory
    if (!resolvedPath.startsWith(uploadsDir)) {
        throw new Error('Invalid file path');
    }
    
    // Check for path traversal attempts
    if (filePath.includes('..') || filePath.includes('~')) {
        throw new Error('Invalid file path');
    }
    
    return resolvedPath;
}

module.exports = {
    generalLimiter,
    strictLimiter,
    uploadLimiter,
    feeLimiter,
    securityHeaders,
    validateFilePath
};

