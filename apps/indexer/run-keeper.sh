#!/bin/sh
# Local stopgap runner. The keeper belongs on the VPS under systemd; this is for
# driving it from a workstation while that host is unreachable.
cd "$(dirname "$0")"
KEEPER_PRIVATE_KEY="$(cat /c/Users/carne/.arcanium-keeper.key)"
export KEEPER_PRIVATE_KEY
export ARC_RPC_URLS="https://rpc.quicknode.mainnet.arc.io,https://rpc.arc-scan.org"
export KEEPER_INTERVAL_MS="${KEEPER_INTERVAL_MS:-900000}"
exec node dist/keeper.js
