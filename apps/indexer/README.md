# Arcanium indexer

Reads Arc, writes Postgres. The website then never touches an RPC on a page
load.

## Why it exists

Arc's public RPC charges roughly the same latency for every request regardless
of size. Measured against `https://rpc.arc-scan.org`:

| call | work done | time |
| --- | --- | --- |
| `eth_blockNumber` | none | 415–672 ms |
| `getLogs`, 9,500 blocks | real | 461–483 ms |

That is a round-trip cost, not a compute cost, so it cannot be optimised away by
asking for less. Explore needs the token list, per-token pool state, and a 24h
trade window — dozens of calls. Caching only moves the pain: the first visitor
after every expiry pays all of it, and on Vercel that is most visitors, because
an in-process cache rarely survives to a second request.

This process pays the latency once, continuously, on a machine that stays warm.
Page loads become indexed Postgres queries.

## What it does per cycle

1. **Rewind check** — refetch the block each cursor stopped at. A different hash
   means a reorg: orphaned swaps are deleted, affected candles recomputed, the
   cursor moved back 128 blocks.
2. **Launches** — one `getLogs` across *all four factory generations* per 9,000
   block range. Name, symbol and fee mode are read once and stored.
3. **Swaps** — one `getLogs` across *all pools* per range, shared cursor. Rows
   are bulk-inserted per chunk.
4. **Holders** — Transfer events across all launch tokens, netted per chunk and
   applied as balance deltas.
5. **Fees** — `FeesDistributed` across every distributor generation.
6. **Pool refresh** — quote balance per pool via Multicall3; graduation at 9,000
   USDC.
7. **Rollup** — price, market cap, 24h volume, 24h change, buy/sell counts,
   holder count and payout totals, all derived in SQL.
8. **Metadata mirror** — `metadata_uri` copied into `token_metadata`, which is
   where the site reads token logos and socials from.
9. **Health** — tip, cursor positions and timestamp into `indexer_health`.

The swaps, holders and fees walks never run past where launches have been read.
If a launch chunk fails and stalls, a pool or token discovered later would
otherwise already be behind those cursors, and its early history would never be
read — a hole nothing retries.

Everything derived is recomputed from raw rows rather than accumulated, so
re-scanning a range is always safe. That property is what makes restarts,
rewinds and backfills boring.

Holder balances are the one exception: they accumulate, because recomputing them
would mean re-reading every Transfer ever. A reorg therefore cannot be absorbed
by re-scanning, and `rewindIfReorged` wipes the `holders` table and restarts that
walk instead. Reorgs are rare and the re-walk is ~750 requests.

## Cost of a full backfill

From the v1 factory at block 12,775,070 to the tip is ~6.7M blocks.

| | requests |
| --- | --- |
| launches (4 factories, one walk) | ~750 |
| swaps (all pools, one walk) | ~750 |
| holders (all tokens, one walk) | ~750 |
| fees (3 distributors, one walk) | ~750 |
| block timestamps | one per block containing a log |

Measured: the first full backfill took 13.6 minutes for launches and swaps.

Walking per factory and per token instead — which is what the first version did
— would have been ~3,000 and ~15,000 respectively, plus one `getBlock` per
individual swap.

## Configuration

`DATABASE_URL` is the only required variable. Everything else has a working
default in `src/main.ts`.

| variable | default |
| --- | --- |
| `DATABASE_URL` | — (required) |
| `ARC_RPC_URLS` | `https://rpc.quicknode.mainnet.arc.io,https://rpc.arc-scan.org` (comma-separated; failover in order) |
| `ARCH_LAUNCHPAD_FACTORIES` | the four known generations |
| `ARCH_MODE_DISTRIBUTOR_ADDRESS` | `0x7c148B6a581E32CcB6ffF7Bd59AF4250d5ec1eBc` |
| `ARCH_FEE_DISTRIBUTORS` | the three known distributor generations |
| `INDEXER_START_BLOCK` | `12775070` |
| `GRADUATION_QUOTE_UNITS` | `9000000000` |
| `LOG_LEVEL` | `info` |

The website reads the same `DATABASE_URL`, so the indexer must write to the
database Vercel reads — for us, Neon. Do not point it at a Postgres on the VPS
unless Vercel can reach that too.

## Do not let it fall far behind

Arc's public RPCs keep only a few days of logs — measured at roughly 500k blocks
on arc-scan and somewhat more on QuickNode. An outage longer than that is not
just a gap to catch up on: the swaps in that window are gone from every public
endpoint and cannot be recovered.

The walks skip a range they have retried and cannot read, so the indexer will
recover on its own rather than wedging on the same chunk forever (it did exactly
that after a nine-day outage, and served nothing until the chunk was skipped).
But skipping is a loss, not a repair. Treat a stopped indexer as urgent.

Launches are the exception: they can always be re-derived from the factories'
`allTokens()` enumeration, which does not depend on log retention.

## Restoring it after an outage

If `https://arcanium.trade/api/indexer` reports `ok: false`, or the service is
not running, this is the whole procedure. Run it as root on the VPS.

**Pull first — this is not optional.** A build from before the pruning fix will
wedge on the first unreadable chunk and never catch up, which is exactly how the
nine-day outage turned into a site serving no volume at all.

```bash
cd /opt/arcanium
git pull
pnpm install --frozen-lockfile
pnpm --filter @arch/indexer... build
chown -R arcanium:arcanium /opt/arcanium
```

The `...` after the filter is load-bearing: it builds the workspace packages the
indexer depends on. Without it `@arch/database` has no `dist/index.d.ts`, its
`Sql` type silently degrades to `any`, and the build fails on a clean checkout
with an implicit-any error that never appears on a machine where those packages
happen to be built already.

Point it at the RPC we actually rely on (older deployments say arc-scan only):

```bash
# /etc/arcanium/indexer.env
ARC_RPC_URLS=https://rpc.quicknode.mainnet.arc.io,https://rpc.arc-scan.org
```

Start it and watch the first cycle:

```bash
systemctl daemon-reload
systemctl enable --now arcanium-indexer
journalctl -u arcanium-indexer -f
```

A backfill of a few days logs `range pruned by the RPC; skipping it` a few dozen
times per stream before it reaches readable history. That is the fix working,
not a fault — but the count is worth reading, because each skipped chunk is
trades that no longer exist anywhere public.

Confirm from outside the box:

```bash
curl -s https://arcanium.trade/api/indexer
# {"ok":true,"tip":"...","behind":"2","ageSeconds":3,"reason":null}
```

`behind` should fall to single digits and `ageSeconds` stay under ~15. Until
then the site falls back to chain reads and shows no volume or 24h change.

**Only one indexer at a time.** If a catch-up was being run from a workstation
during the outage, stop it once the service is healthy. Two processes sharing
the cursors will race each other; the writes are idempotent upserts so nothing
corrupts, but they will fight over progress and waste the RPC's rate limit.

## Deploying to the VPS

AlmaLinux 8. The distro's Node is far too old; install a current one from
NodeSource.

```bash
# as root
dnf module reset -y nodejs
curl -fsSL https://rpm.nodesource.com/setup_22.x | bash -
dnf install -y nodejs git
corepack enable

useradd --system --home /opt/arcanium --shell /sbin/nologin arcanium
mkdir -p /opt/arcanium /etc/arcanium
chown arcanium:arcanium /opt/arcanium
```

Ship the code and build:

```bash
# as root
git clone <repo> /opt/arcanium
cd /opt/arcanium
pnpm install --frozen-lockfile
pnpm --filter @arch/indexer... build
chown -R arcanium:arcanium /opt/arcanium
```

Secrets go in a file only root writes and only the service reads. **Never put
them in the unit file** — unit files are world-readable.

```bash
# as root
cat > /etc/arcanium/indexer.env <<'EOF'
DATABASE_URL=postgresql://...   # the same Neon URL Vercel uses
# QuickNode first: faster on a filtered getLogs, and it retains noticeably more
# log history than arc-scan, which matters because Arc's public nodes prune.
ARC_RPC_URLS=https://rpc.quicknode.mainnet.arc.io,https://rpc.arc-scan.org
LOG_LEVEL=info
EOF
chown root:arcanium /etc/arcanium/indexer.env
chmod 640 /etc/arcanium/indexer.env
```

Install and start:

```bash
# as root
cp /opt/arcanium/apps/indexer/deploy/arcanium-indexer.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now arcanium-indexer
journalctl -u arcanium-indexer -f
```

The first run backfills. Expect roughly 15–20 minutes before `health` reports
`behind` in the low hundreds; until then the website keeps using its on-chain
path, because `indexer_health` says the indexer is not caught up yet.

### Updating

```bash
cd /opt/arcanium && git pull
pnpm install --frozen-lockfile && pnpm --filter @arch/indexer... build
systemctl restart arcanium-indexer
```

Restarting is always safe. Cursors are in the database, and every write is an
upsert.

### Checking on it

```bash
systemctl status arcanium-indexer
journalctl -u arcanium-indexer -n 100 --no-pager
journalctl -u arcanium-indexer -p warning --since '1 hour ago'
```

The `health` line each cycle carries `tip` and `behind`. Steady state is
`behind` under ~50 (about 25 seconds of Arc blocks). A number that climbs means
the RPC is failing chunks — `chunk failed` warnings will say so.

## If the indexer stops

Nothing breaks. Every read path in the website checks `indexer_health` first and
falls back to reading the chain when the row is older than two minutes or more
than 1,000 blocks behind. The site gets slow again; it does not go wrong or go
empty.
