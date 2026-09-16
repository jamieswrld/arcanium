#!/bin/sh
# Local catch-up runner. The production indexer runs under systemd on its own
# host; this is for driving a backfill from a workstation when that host is down.
cd "$(dirname "$0")"
DATABASE_URL="$(grep -h '^DATABASE_URL=' ../../.env | head -1 | cut -d= -f2-)"
export DATABASE_URL
export ARC_RPC_URLS="${ARC_RPC_URLS:-https://rpc.quicknode.mainnet.arc.io,https://rpc.arc-scan.org}"
exec node dist/main.js
