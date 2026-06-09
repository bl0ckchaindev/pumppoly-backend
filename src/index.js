require('dotenv').config();
const cors = require('cors');
const express = require('express');
const { securityHeaders, generalLimiter } = require('./middleware/security');

// Handle unhandled errors to prevent crashes
process.on('unhandledRejection', (reason, promise) => {
    // Check if it's the WebSocket provider callback error
    if (reason && reason.message && (
        reason.message.includes('Cannot read properties of undefined') && 
        reason.message.includes('callback')
    )) {
        console.warn('⚠ WebSocket provider error detected (unhandled rejection):', reason.message);
        console.warn('   This is a known ethers.js WebSocket provider issue');
        console.warn('   The event listener will continue with HTTP polling as fallback');
        // Try to recover by switching to HTTP provider
        try {
            const { getEventListener } = require('./eventListener');
            const listener = getEventListener();
            if (listener && listener.provider && listener.isWebSocket) {
                console.warn('   Attempting to switch to HTTP provider...');
                // Will be handled by the listener's error handling
            }
        } catch (err) {
            // Ignore recovery errors
        }
        return; // Don't exit
    }
    console.error('⚠ Unhandled Rejection:', reason);
    // Don't exit - log and continue
});

process.on('uncaughtException', (error) => {
    // Check if it's the WebSocket provider callback error
    if (error.message && (
        error.message.includes('Cannot read properties of undefined') && 
        error.message.includes('callback')
    )) {
        console.warn('⚠ WebSocket provider error detected (uncaught exception):', error.message);
        console.warn('   This is a known ethers.js WebSocket provider issue');
        console.warn('   The event listener will continue with HTTP polling as fallback');
        // Try to recover
        try {
            const { getEventListener } = require('./eventListener');
            const listener = getEventListener();
            if (listener && listener.provider && listener.isWebSocket && require('./config').httpRpcUrl) {
                console.warn('   Switching to HTTP provider...');
                // Destroy WebSocket provider and reinitialize with HTTP
                if (listener.provider.destroy) {
                    listener.provider.destroy().catch(() => {});
                }
                listener.provider = null;
                listener.isWebSocket = false;
                listener.initialize().catch(() => {});
            }
        } catch (err) {
            console.error('   Recovery failed:', err.message);
        }
        return; // Don't exit
    }
    // For other errors, log but don't crash immediately
    console.error('⚠ Uncaught Exception:', error.message);
    console.error('   Stack:', error.stack);
    console.error('⚠ Continuing despite error...');
});

// Supabase setup
const { supabase } = require('./config/supabase');

// Test Supabase connection with retry logic
async function testSupabaseConnection(retries = 3, delay = 2000) {
    for (let i = 0; i < retries; i++) {
        try {
            const { data, error } = await supabase.from('tokens').select('count').limit(1);
            if (error && error.code !== 'PGRST116') {
                throw error;
            }
            console.log('✓ Supabase Database Connected');
            return true;
        } catch (err) {
            if (i < retries - 1) {
                console.log(`⚠ Supabase connection attempt ${i + 1} failed, retrying in ${delay}ms...`);
                await new Promise(resolve => setTimeout(resolve, delay));
                delay *= 2; // Exponential backoff
            } else {
                console.error('✗ Failed to connect to Supabase after', retries, 'attempts:', err.message);
                console.log('⚠ Server will continue to start, but Supabase operations may fail');
                return false;
            }
        }
    }
    return false;
}

// Test connection asynchronously (don't block server startup)
testSupabaseConnection();

const app = express();

// Security headers
app.use(securityHeaders);

// CORS configuration
// Allowed origins come from defaults + the CORS_ORIGINS env var (comma-separated). In
// development (NODE_ENV !== 'production') any localhost / 127.0.0.1 origin is allowed on any
// port, so the frontend dev server (e.g. :3000, :5173, :8080) works without config changes.
const DEFAULT_ALLOWED_ORIGINS = [
    'https://pumppoly.com',
    'https://www.pumppoly.com',
    'https://app.pumppoly.com',
    'http://localhost:3000',
    'http://localhost:8080'
];
const ENV_ALLOWED_ORIGINS = (process.env.CORS_ORIGINS || '')
    .split(',')
    .map(o => o.trim())
    .filter(Boolean);
const ALLOWED_ORIGINS = new Set([...DEFAULT_ALLOWED_ORIGINS, ...ENV_ALLOWED_ORIGINS]);
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const LOCALHOST_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

app.use(cors({
    origin(origin, callback) {
        // No Origin header: same-origin, curl, or server-to-server — allow.
        if (!origin) return callback(null, true);
        if (ALLOWED_ORIGINS.has(origin)) return callback(null, true);
        if (!IS_PRODUCTION && LOCALHOST_ORIGIN.test(origin)) return callback(null, true);
        return callback(new Error(`Not allowed by CORS: ${origin}`));
    },
    credentials: true, // reflects the specific origin (never '*') so credentialed requests work
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
}));

// Body parsing with size limits
// Only parse JSON for requests with JSON content type (skip multipart/form-data for file uploads)
app.use((req, res, next) => {
    const contentType = req.headers['content-type'] || '';
    // Skip JSON parsing for multipart/form-data (file uploads)
    if (contentType.includes('multipart/form-data')) {
        return next();
    }
    // Parse JSON only for JSON content type
    if (contentType.includes('application/json')) {
        return express.json({ limit: '10mb' })(req, res, next);
    }
    // For other content types, continue to next middleware
    next();
});
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Apply rate limiting to all routes
app.use(generalLimiter);

const routes = require('./routes');
const { getEventListener } = require('./eventListener');
const { contractAddr } = require('./config');
const { getEvmChainSlug } = require('./lib/chainUtils');

const port = process.env.PORT || 3010

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        timestamp: new Date().toISOString(),
        database: 'supabase'
    });
});

app.use('/', routes)

// Initialize services after database connection with retry logic
async function initializeServices(retries = 3, delay = 5000) {
    for (let attempt = 0; attempt < retries; attempt++) {
        try {
            console.log(`Initializing services... (attempt ${attempt + 1}/${retries})`);
            
            const tokenService = require('./services/tokenService');
            
            // Step 1: Start factory event listener to detect new token creations
            console.log('Step 1: Starting factory event listener...');
            try {
                if (contractAddr) {
                    const eventListener = getEventListener();
                    await eventListener.initialize();
                    await eventListener.listenToFactory(contractAddr);
                    console.log('✓ Factory event listener started - will automatically detect new tokens');
                } else {
                    console.warn('⚠ CONTRACT_ADDRESS not set - factory event listener not started');
                    console.warn('  Set CONTRACT_ADDRESS in .env to enable automatic token detection');
                }
            } catch (error) {
                console.error('✗ Error starting factory listener:', error.message);
                if (attempt < retries - 1) {
                    throw error; // Retry
                }
            }

            // Step 2: Start listening to existing active bonding curves (EVM)
            console.log('Step 2: Starting listeners for existing EVM bonding curves...');
            try {
                const syncResult = await tokenService.syncAllActiveBondingCurves(getEvmChainSlug());
                console.log(`✓ Started listening to ${syncResult.started} EVM bonding curve(s)`);
                if (syncResult.failed > 0) {
                    console.log(`  ⚠ Failed to start ${syncResult.failed} listener(s)`);
                }
            } catch (error) {
                console.error('✗ Error syncing EVM bonding curves:', error.message);
                console.log('  ⚠ Make sure you have run the database migration: supabase-migration-multi-chain.sql');
                // Don't fail startup if this fails
            }

            // Step 3: Start Solana event listener
            console.log('Step 3: Starting Solana event listener...');
            try {
                const solanaEventListener = require('./solanaEventListener');
                await solanaEventListener.startListening();
                console.log('✓ Solana event listener started');
            } catch (error) {
                console.error('✗ Error starting Solana listener:', error.message);
                console.log('  ⚠ Solana tokens may not be automatically detected');
                // Don't fail startup if this fails
            }

            // Step 4: Start cron service (catch-up, health check, reward distribution)
            console.log('Step 4: Starting cron service...');
            try {
                const cronService = require('./services/cronService');
                cronService.start();
                console.log('✓ Cron service started (catch-up, health check, reward distribution)');
            } catch (error) {
                console.error('✗ Error starting cron service:', error.message);
                // Don't fail startup
            }

            console.log('✓ Services initialized successfully');
            return; // Success, exit retry loop
            
        } catch (error) {
            if (attempt < retries - 1) {
                console.log(`⚠ Initialization attempt ${attempt + 1} failed, retrying in ${delay}ms...`);
                console.log(`  Error: ${error.message}`);
                await new Promise(resolve => setTimeout(resolve, delay));
                delay *= 1.5; // Increase delay for next retry
            } else {
                console.error('✗ Failed to initialize services after', retries, 'attempts');
                console.error('  Last error:', error.message);
                console.log('⚠ Server is running, but some services may not be fully initialized');
                console.log('  Services will retry on next scheduled run');
            }
        }
    }
}

// Initialize services after a delay to ensure Supabase connection is ready
// Use longer initial delay and retry logic
setTimeout(() => initializeServices(), 3000);

// Listen on all network interfaces (0.0.0.0) to allow external connections
// This is required so frontend on the same server can access the backend
const host = process.env.HOST || '0.0.0.0';

app.listen(port, host, () => {
    console.log(`✓ Server started on http://${host}:${port}`);
    console.log(`✓ Using database: Supabase`);
    console.log(`✓ Backend API accessible from: http://localhost:${port} or http://YOUR_SERVER_IP:${port}`);
    console.log(`✓ For frontend integration, use API URL: http://localhost:${port}`);
})
