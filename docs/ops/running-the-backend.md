# Running the Arch backend

All backend services are built and typechecked. Two need a Postgres URL
(indexer, and the token/candle API endpoints); the bridge workers, gas
relayer, solvency, and reconciliation need only RPC access. For continuous
operation these run on a small VPS (see the cost sheet); locally they run from
compiled `dist/`.

## Postgres (2-minute free setup)

Any Postgres works. Fastest is Neon (neon.tech) free tier: create a project,
copy the connection string, put it in `.env` as `DATABASE_URL`. Migrations run
automatically on indexer start (`packages/database/migrations`).

## Services

```sh
pnpm build   # once

# Bridge (no DB needed) — the trust-critical loops:
node apps/bridge-worker/dist/main.js     # Base deposit -> Arc mint
node apps/redeem-worker/dist/main.js     # Arc burn -> Base release

# Gas relayer runs as Vercel routes in production; standalone:
node apps/gas-relayer/dist/main.js

# Indexer (needs DATABASE_URL) — fills tokens/swaps/candles/graduation:
node apps/indexer/dist/main.js

# Public API (bridge endpoints always; token endpoints need DATABASE_URL):
node apps/api/dist/main.js               # :4000

# Reconciliation — evidence-only pending-action report (no DB):
node apps/admin/dist/reconcile.js
```

## Live endpoints (already deployed on the web app)

- `GET /api/solvency` — reserve vs supply, ratio, solvent flag. **Live now**,
  reads both chains. This is the public proof Arch is fully backed.
- `POST /api/gas/quote`, `POST /api/gas/drip` — gas station (live).

## API surface (apps/api, once DATABASE_URL is set + indexer running)

```text
POST /v1/bridge/quote            live fee/limit quote
GET  /v1/bridge/actions/:id      status proven vs on-chain processed mappings
GET  /v1/bridge/address/:addr    reconstructed bridge history
GET  /v1/bridge/solvency         reserve vs supply
GET  /v1/tokens?sort=            newest|market_cap|volume_24h|oldest|graduated
GET  /v1/tokens/:token           token detail
GET  /v1/tokens/:token/candles?interval=  1m|5m|15m|1h|4h|1d
GET  /v1/tokens/:token/trades    recent swaps
GET  /v1/platform/stats          counts
```

## Reorg + reconciliation model

The indexer stores `(block_number, block_hash)` cursors; a hash mismatch
rewinds the affected range. Correctness never depends on the indexer or the
DB: the bridge's on-chain processed mappings are the source of truth, so a
wiped database is rebuilt by re-scanning. `reconcile.js` reports any action
whose destination side is unprocessed and never marks anything complete
without an on-chain destination transaction.
