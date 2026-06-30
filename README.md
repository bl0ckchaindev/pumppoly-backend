# PumpPoly Backend

Node.js backend for a pump.fun-style bonding-curve token launchpad. It indexes on-chain token creation and trades on **EVM chains** and **Solana**, stores data in **Supabase**, serves the frontend API, and runs the **reward distribution** engine.

There is no creation fee — revenue comes from a **1.1% per-trade fee** (split between platform, creator, and a trader-reward pool).

## Tech Stack

- Node.js + Express
- Ethers.js (EVM) and `@solana/web3.js` + `@coral-xyz/anchor` (Solana)
- Supabase (PostgreSQL)
- node-cron, multer

## Setup

```bash
cd backend
npm install
# create .env (see below)
npm run dev     # development
npm start       # production
```

Runs on `http://localhost:3010` by default.

## Database

Run `db_migration/supabase-schema.sql` in the Supabase SQL editor on a fresh project. It's the complete schema (all migrations folded in) — the only SQL file you need.

## Environment Variables

Create `.env` in `backend/`:

```env
# Server
PORT=3010

# Supabase (use the service role key, not anon)
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_KEY=your-service-role-key

# EVM
NET_ID=11155111                  # chain id (1, 137, 56, 8453, 11155111 …)
HTTP_RPC_URL=https://...          # required
WS_RPC_URL=wss://...              # optional, recommended
CONTRACT_ADDRESS=0x...            # Factory contract
EVM_TREASURY_PRIVATE_KEY=0x...    # pays EVM reward/creator payouts

# Solana
SOLANA_RPC_URL=https://api.devnet.solana.com
SOLANA_TREASURY_PRIVATE_KEY=[1,2,...,64]   # JSON array, program owner + payer

# Bonding curve (EVM, wei)
VIRTUAL_ETH_LP_INITIAL=35000000000000000
REAL_TOKEN_LP_INITIAL=200000000000000000000000000
BONDING_LIMIT=100000000000000000   # graduates when real_eth_lp >= this
```

## How It Works

On startup the server:

1. Listens to the EVM Factory contract for new tokens and to each bonding curve for trades.
2. Listens to the Solana `fomo` program for create/trade events.
3. Stores tokens, trades, prices, and fees in Supabase.
4. Runs cron jobs: hourly health check + per-minute reward distribution check.

Every trade charges **1.1%**, split into platform (0.35%), creator (0.45%), and reward pool (0.30%). Each epoch, the reward pool is paid out to traders (2% per-wallet cap, wash-trade cooldown) and accumulated creator fees are paid to token creators — from the treasury wallets.

## API Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/health` | Service status |
| POST | `/tokens/register` | Register an EVM token after creation |
| POST | `/tokens/process-trade` | Index a trade from its tx hash |
| POST | `/tokens/ensure-listening` | Ensure a curve is being listened to |
| GET | `/trader-fee-claimable` | Estimated trader reward for a wallet |
| GET | `/creator-fee-claimable` | Accumulated creator fee for a wallet |
| POST | `/claim-trader-fee` | Manually pay a wallet's unclaimed fees |
| GET/PATCH | `/reward-distribution/config` | Read/update distribution settings |
| POST | `/reward-distribution/run` | Trigger one distribution epoch |
| POST | `/update-global-config` | Update Solana program fees (owner) |
| POST | `/uploads/logo` · `/banner` · `/profile` · `/comment` | File uploads |

## Helper Scripts

```bash
node scripts/init-solana-config.js                         # one-time Solana config init (run after deploy)
node scripts/manual-catchup.js <curveAddr> <start> <end>   # reprocess missed EVM trades
```

## Project Structure

```
backend/
├── db_migration/        # Supabase schema (single consolidated file)
├── src/
│   ├── abi/             # EVM ABIs
│   ├── idl/fomo.json    # Solana program IDL
│   ├── routes/          # API routes
│   ├── services/        # DB, tokens, rewards, Solana/EVM payouts
│   ├── eventListener.js        # EVM listener
│   ├── solanaEventListener.js  # Solana listener
│   └── index.js         # entry point
└── scripts/             # ops scripts: init-solana-config, set-solana-roles, sync-holders-once, manual-catchup, reconcile-chain-slug
```

## License

ISC
