# PumpPoly Backend — Deployment Guide

Node.js + Express service that indexes on-chain token creation and trades (Base / Solana),
stores them in Supabase, serves the frontend API + image uploads, and runs the reward engine.

> No `.env` is included in this package. Copy the template and fill in **your own** values.
> `env.example` is the same file as `.env.example` (provided without the leading dot so it stays
> visible after unzipping on Windows).

---

## 1. Prerequisites

- **Node.js 18 or 20 LTS** and npm
- A **Supabase** project (PostgreSQL)
- A **Base mainnet** RPC endpoint (HTTPS + WSS) — Alchemy / QuickNode / Chainstack / `https://mainnet.base.org`
- A **Solana mainnet** RPC endpoint
- Deployed contracts (Base `FactoryUpgradeable` proxy + `RewardClaim`, and the Solana `fomo` program)
- A process manager for production (**pm2** recommended)

---

## 2. Install

```bash
cd backend
npm install
```

## 3. Database (Supabase)

In the Supabase SQL editor:

- **Fresh project:** run `db_migration/supabase-schema.sql`.
- **Existing DB:** apply the `db_migration/supabase-migration-*.sql` files in date order.

Copy the project URL and the **service role** key into `.env` (next step).

## 4. Configure environment

```bash
cp env.example .env      # or: cp .env.example .env
```

Fill in `.env` (see the inline comments). Key groups:

| Group | Keys |
|---|---|
| Server | `PORT`, `NODE_ENV=production`, `FRONTEND_URL` (for CORS) |
| Admin | `ADMIN_API_KEY` — protects the admin endpoints (see below) |
| Supabase | `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` (service role — secret) |
| EVM (Base = 8453) | `NET_ID=8453`, `HTTP_RPC_URL`, `WS_RPC_URL`, `CONTRACT_ADDRESS` (factory proxy), `FACTORY_DEPLOY_BLOCK`, `EVM_CHAIN_SLUG=base` |
| EVM keys (secret) | `EVM_TREASURY_PRIVATE_KEY`, `REWARD_CLAIM_ADDRESS`, `REWARD_SIGNER_PRIVATE_KEY` |
| Solana | `SOLANA_RPC_URL`, `SOLANA_TREASURY_PRIVATE_KEY` (JSON byte array — secret) |
| Bonding curve (wei) | `BONDING_LIMIT=10 ETH`, `VIRTUAL_ETH_LP_INITIAL=3.5 ETH`, `REAL_TOKEN_LP_INITIAL` |

> `EVM_CHAIN_SLUG` **must** match the frontend's chain→slug mapping (`8453 → "base"`), or the
> listener and frontend will write different slugs and create duplicate rows.

### Admin endpoints (protected)
Two endpoints perform privileged actions and require the admin key (`ADMIN_API_KEY`):

| Endpoint | Purpose |
|---|---|
| `POST /update-global-config` | Updates the Solana program config on-chain (fees, threshold, `fee_recipient`) — signed with the treasury/owner key |
| `PATCH /reward-distribution/config` | Updates reward-distribution settings in the DB |

Call them with header `x-admin-key: <ADMIN_API_KEY>` (or `Authorization: Bearer <ADMIN_API_KEY>`).
If `ADMIN_API_KEY` is unset these return **503** (locked), never open. The legacy treasury-paid
endpoints `POST /reward-distribution/run` and `POST /claim-trader-fee` were **removed** — rewards
are claim-only (users pay their own gas).

### Solana IDL
The program IDL lives at `src/idl/fomo.json` and the backend reads the program id from its
`address` field. **After deploying your own `fomo` program, replace this file with the
`anchor build`-regenerated IDL** (the new program id flows through automatically).

## 5. One-time Solana config

After the `fomo` program is deployed, initialize its global config once:

```bash
node init-solana-config.js
```

Use the production values: creator 0.45% / reward 0.30% / platform 0.35% (total 1.1%),
graduation at **85 SOL**, and your treasury as `fee_recipient`.

## 6. Run

```bash
npm start          # production (node src/index.js)
npm run dev        # development (nodemon)
```

Listens on `http://localhost:3010` (or `PORT`). On startup it begins the EVM + Solana event
listeners and schedules the cron jobs (health check + reward distribution).

### Production with pm2

```bash
npm install -g pm2
pm2 start src/index.js --name pumppoly-api
pm2 save
pm2 startup        # follow the printed command to enable on boot
```

## 7. Reverse proxy + TLS (nginx)

Put the API behind nginx with HTTPS (Let's Encrypt). Minimal proxy block:

```nginx
server {
    listen 443 ssl;
    server_name api.your-domain.com;

    ssl_certificate     /etc/letsencrypt/live/api.your-domain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/api.your-domain.com/privkey.pem;

    # Allow image uploads
    client_max_body_size 25m;

    location / {
        proxy_pass http://127.0.0.1:3010;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Uploaded images are served from `/uploads/...`. Make sure `client_max_body_size` is large
enough for logos/banners, and that the `src/uploads/` directory is writable by the process.

## 8. Helper scripts

```bash
node init-solana-config.js                          # one-time Solana global-config init
node manual-catchup.js <curveAddr> <start> <end>    # reprocess missed EVM trades
node reconcile-chain-slug.js                        # fix chain-slug mismatches in the DB
node sync-holders-once.js                           # one-off holder snapshot sync
```

## 9. Security checklist

- Never commit `.env`. Keep `SUPABASE_SERVICE_KEY`, `SOLANA_TREASURY_PRIVATE_KEY`,
  `EVM_TREASURY_PRIVATE_KEY`, and `REWARD_SIGNER_PRIVATE_KEY` secret.
- Use dedicated treasury/signer wallets, funded only as needed.
- Restrict `FRONTEND_URL` / `CORS_ORIGINS` to your real domains.
