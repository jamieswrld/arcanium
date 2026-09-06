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
4. **Pool refresh** — quote balance per pool via Multicall3; graduation at 9,000
   USDC.
5. **Rollup** — price, market cap, 24h volume, 24h change, buy/sell counts, all
   derived in SQL from the `swaps` table.
6. **Metadata mirror** — `metadata_uri` copied into `token_metadata`, which is
   where the site reads token logos and socials from.
7. **Health** — tip, cursor positions and timestamp into `indexer_health`.

Everything derived is recomputed from raw swaps rather than accumulated, so
re-scanning a range is always safe. That property is what makes restarts,
rewinds and backfills boring.

## Cost of a full backfill

From the v1 factory at block 12,775,070 to the tip is ~6.7M blocks.

| | requests |
| --- | --- |
| launches (4 factories, one walk) | ~750 |
| swaps (all pools, one walk) | ~750 |
| block timestamps | one per block containing a log |

Walking per factory and per token instead — which is what the first version did
— would have been ~3,000 and ~15,000 respectively, plus one `getBlock` per
individual swap.

## Configuration

`DATABASE_URL` is the only required variable. Everything else has a working
default in `src/main.ts`.

| variable | default |
| --- | --- |
| `DATABASE_URL` | — (required) |
| `ARC_RPC_URLS` | `https://rpc.arc-scan.org` (comma-separated; failover in order) |
| `ARCH_LAUNCHPAD_FACTORIES` | the four known generations |
| `ARCH_MODE_DISTRIBUTOR_ADDRESS` | `0x7c148B6a581E32CcB6ffF7Bd59AF4250d5ec1eBc` |
| `INDEXER_START_BLOCK` | `12775070` |
| `GRADUATION_QUOTE_UNITS` | `9000000000` |
| `LOG_LEVEL` | `info` |

The website reads the same `DATABASE_URL`, so the indexer must write to the
database Vercel reads — for us, Neon. Do not point it at a Postgres on the VPS
unless Vercel can reach that too.

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
pnpm --filter @arch/indexer build
chown -R arcanium:arcanium /opt/arcanium
```

Secrets go in a file only root writes and only the service reads. **Never put
them in the unit file** — unit files are world-readable.

```bash
# as root
cat > /etc/arcanium/indexer.env <<'EOF'
DATABASE_URL=postgresql://...   # the same Neon URL Vercel uses
ARC_RPC_URLS=https://rpc.arc-scan.org
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
pnpm install --frozen-lockfile && pnpm --filter @arch/indexer build
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
