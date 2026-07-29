# ADR 0006 — Network gating, Arc mainnet uncertainty, and the aUSD wind-down

Status: Accepted · Date: 2026-07-28

## Network gating

Four network profiles exist in `packages/chain-config`: `baseSepolia`, `baseMainnet`, `arcTestnet`, `arcMainnet`. Every chain ID, RPC URL, explorer URL, USDC address, Uniswap address, deployment block, and confirmation count comes from typed environment configuration — nothing chain-specific is compiled in for `arcMainnet`.

Observed evidence (Envelope's live deployment) points to Arc chain ID **5042**, with Uniswap v3 PositionManager `0x3965…1377` and SwapRouter `0x4C91…4720`; but official Arc docs, as fetched, still describe Arc as testnet-only and third-party sources conflict. Therefore:

- `ENABLE_ARC_MAINNET=false`, `ENABLE_REAL_BRIDGE=false`, `ENABLE_REAL_TRADING=false` by default.
- Flipping any of these requires the address book to be re-verified against official Circle/Arc/Uniswap publications and recorded in `docs/reference/addresses` with sources.
- Config validation refuses to start an app pointed at `arcMainnet` unless every required address is present **and** `ENABLE_ARC_MAINNET=true`.

Arc gas nuance (verified from Circle docs): the native gas asset and the ERC-20 USDC interface at `0x3600…0000` expose the same balance; the native view uses 18 decimals, the ERC-20 view 6. All Arch code paths that touch Arc value must state which view they use; `packages/config` exposes both scalars and `packages/sdk` provides the conversion utilities. Both native transfer and ERC-20 allowance flows get integration tests.

## aUSD wind-down (migration end-state)

Stages (parity with Envelope's documented wind-down): pause new deposits → record final aUSD supply → prove `reserve ≥ supply` → move reserve to Arc via the approved route → open a **permanent, deadline-free 1:1 aUSD→USDC exchange** that cannot open undercollateralized → migrate every aUSD pool (withdraw via the narrow migration authorization in `ArchLiquidityVault`, exchange 1:1, recreate the pool at the same price with the same token amounts, same fee recipients) → update factory `pairToken` → indexer marks per-pool migration state. No value-neutrality claim is made until invariant and fork tests demonstrate it (Milestone 8 gate).
