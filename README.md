# PumpPoly Backend

A Node.js backend service for tracking token creation and trading events on Polygon blockchain using bonding curve mechanics. This service monitors factory contracts for new token creation and bonding curve contracts for trading events, storing all data in Supabase.

## Features

- 🔗 **Blockchain Event Monitoring**: Real-time monitoring of `TokenCreated` and `TokenTraded` events
- 📊 **Bonding Curve Tracking**: Calculates and tracks virtual and real liquidity pool values
- 💾 **Database Integration**: Supabase integration for token and trading data storage
- 🔄 **Event Catch-up**: Automatically catches up on missed events during downtime
- 📤 **File Upload**: Handles token logos, banners, profile images, and comment images
- 🔒 **Security**: Rate limiting, CORS, security headers, and input validation
- ⚡ **WebSocket & HTTP**: Supports both WebSocket and HTTP RPC providers with automatic fallback

## Tech Stack

- **Runtime**: Node.js
- **Framework**: Express.js
- **Blockchain**: Ethers.js (v5.5.2)
- **Database**: Supabase (PostgreSQL)
- **Network**: Polygon (MATIC)
- **Security**: Helmet, express-rate-limit, express-validator

## Prerequisites

- Node.js (v14 or higher)
- npm or yarn
- Supabase account and project
- Polygon RPC endpoint (HTTP and/or WebSocket)
- Access to Factory and BondingCurve smart contracts

## Installation

1. Clone the repository:
```bash
git clone <repository-url>
cd pumppoly-backend
```

2. Install dependencies:
```bash
npm install
```

3. Set up environment variables (see [Environment Variables](#environment-variables))

4. Start the server:
```bash
# Development mode (with nodemon)
npm run dev

# Production mode
npm start
```

## Environment Variables

Create a `.env` file in the root directory with the following variables:

### Blockchain Configuration
```env
# Network ID (137 for Polygon Mainnet, 80001 for Mumbai Testnet)
NET_ID=137

# RPC URLs (HTTP is required, WebSocket is optional but recommended)
HTTP_RPC_URL=https://polygon-rpc.com
WS_RPC_URL=wss://polygon-mainnet.g.alchemy.com/v2/YOUR_API_KEY
ORACLE_RPC_URL=https://polygon-rpc.com

# Contract addresses
CONTRACT_ADDRESS=0x...  # Factory contract address
PRIVATE_KEY=0x...  # Wallet private key (for transactions if needed)
```

### Database Configuration
```env
# Supabase credentials
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_KEY=your-service-role-key  # Use service role key, not anon key
# OR
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
```

### Bonding Curve Configuration
```env
# Initial liquidity pool values (in wei/string format)
VIRTUAL_ETH_LP_INITIAL=10000000000000000  # 0.01 ETH (1e16 wei)
VIRTUAL_TOKEN_LP_INITIAL=1073000000000000000000000  # Initial token LP
REAL_ETH_LP_INITIAL=0
REAL_TOKEN_LP_INITIAL=200000000000000000000000000  # 2e26

# Bonding limit (when real_eth_lp >= this, lp_created = true)
BONDING_LIMIT=100000000000000000  # 0.1 ETH (1e17 wei)
```

### Server Configuration (Optional)
```env
PORT=3010
HOST=0.0.0.0
NODE_ENV=production
```

## Project Structure

```
pumppoly-backend/
├── src/
│   ├── abi/                    # Smart contract ABIs
│   │   ├── FactoryABI.json
│   │   └── BondingCurveABI.json
│   ├── config/                 # Configuration files
│   │   └── supabase.js
│   ├── middleware/             # Express middleware
│   │   ├── security.js
│   │   └── validation.js
│   ├── routes/                 # API routes
│   │   ├── index.js
│   │   └── uploadRoutes.js
│   ├── services/               # Business logic
│   │   ├── supabaseService.js
│   │   └── tokenService.js
│   ├── uploads/                # Uploaded files
│   │   ├── tokens/
│   │   ├── profile/
│   │   ├── banner/
│   │   └── comments/
│   ├── config.js               # App configuration
│   ├── eventListener.js        # Blockchain event listener
│   └── index.js                # Entry point
├── package.json
└── README.md
```

## API Endpoints

### File Upload

- `POST /uploads/logo` - Upload token logo
- `POST /uploads/banner` - Upload token banner
- `POST /uploads/profile` - Upload profile image
- `POST /uploads/comment` - Upload comment image

### File Retrieval

- `GET /uploads/tokens/:name` - Get token logo
- `GET /uploads/profile/:name` - Get profile image
- `GET /uploads/:name` - Get uploaded file

### Health Check

- `GET /health` - Server health check

## Event Listening

The service automatically:

1. **Listens to Factory Contract** for `TokenCreated` events
   - Creates new token entry in database
   - Initializes bonding curve data
   - Starts listening to the new bonding curve contract

2. **Listens to Bonding Curve Contracts** for `TokenTraded` events
   - Updates token price data
   - Calculates new liquidity pool values
   - Updates bonding curve metrics (k, lp_created, etc.)

3. **Event Catch-up Mechanism**
   - Periodically checks for missed events
   - Handles reconnections automatically
   - Prevents event gaps during downtime

### Bonding Curve Calculations

The service tracks:
- **Virtual LP**: Initial virtual liquidity pools
- **Real LP**: Actual ETH and token amounts
- **k**: Constant product (virtual_eth_lp * virtual_token_lp)
- **lp_created**: Boolean flag when real_eth_lp >= bonding_limit

## Database Schema

The service uses Supabase with the following main tables:

- **tokens**: Token information
- **bonding_curves**: Bonding curve data (LP values, k, etc.)
- **token_prices**: Historical token price data from trades

See `supabase-schema.sql` for the full database schema.

## Configuration

### Network Configuration

The service supports Polygon Mainnet (NET_ID=137) and testnets. Configure the network in `.env`:

```env
NET_ID=137  # Polygon Mainnet
```

### Provider Configuration

The service prefers WebSocket providers for real-time events but falls back to HTTP polling if WebSocket is unavailable or disconnects.

**Priority:**
1. WebSocket Provider (if `WS_RPC_URL` is set)
2. HTTP Provider (if `HTTP_RPC_URL` is set)

## Deployment

### Using PM2

```bash
# Install PM2
npm install -g pm2

# Start the application
pm2 start src/index.js --name pumppoly-backend

# Save PM2 configuration
pm2 save

# Setup PM2 to start on boot
pm2 startup
```

### Using Nginx Reverse Proxy

See `FRONTEND_SETUP.md` for detailed nginx configuration and frontend integration guide.

### Docker (Optional)

Create a `Dockerfile`:

```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
EXPOSE 3010
CMD ["node", "src/index.js"]
```

Build and run:
```bash
docker build -t pumppoly-backend .
docker run -p 3010:3010 --env-file .env pumppoly-backend
```

## Troubleshooting

### Events Not Being Caught

1. Check RPC provider connectivity:
   ```bash
   curl -X POST -H "Content-Type: application/json" --data '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' $HTTP_RPC_URL
   ```

2. Verify contract addresses are correct
3. Check Supabase connection and permissions
4. Review logs for errors

### WebSocket Connection Issues

If WebSocket provider fails:
- The service automatically falls back to HTTP polling
- Check WebSocket URL format (must start with `wss://`)
- Verify API key permissions for WebSocket endpoint
- Check firewall/network settings

### Database Connection Issues

1. Verify Supabase credentials
2. Ensure you're using the **service role key**, not the anon key
3. Check Row Level Security (RLS) policies
4. Verify network connectivity to Supabase

### Missing Events

The service includes catch-up mechanisms, but if events are still missed:

1. Check the last processed block numbers in logs
2. Verify event signatures match the contract ABI
3. Ensure RPC provider supports historical event queries
4. Check for rate limiting on RPC provider

## Development

### Running in Development

```bash
npm run dev  # Uses nodemon for auto-reload
```

### Logs

The service logs important events:
- ✓ Successful operations
- ⚠ Warnings (reconnections, fallbacks)
- ✗ Errors

### Code Style

- Use async/await for asynchronous operations
- Handle errors gracefully with try-catch
- Use BigInt for large number calculations
- Store large numbers as strings in database

## Security Considerations

- **Environment Variables**: Never commit `.env` files
- **Private Keys**: Store securely, use environment variables
- **Rate Limiting**: Enabled by default on upload endpoints
- **CORS**: Configure appropriately for production
- **Input Validation**: All inputs are validated
- **File Uploads**: Limited file sizes and types

## License

ISC

## Support

For issues and questions, please refer to:
- `FRONTEND_SETUP.md` - Frontend integration guide
- `supabase-schema.sql` - Database schema
- Service logs for debugging information
