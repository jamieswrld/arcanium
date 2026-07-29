# ADR 0003 — Direct Uniswap v3 market, no bonding curve

Status: Accepted · Date: 2026-07-28

## Decision

Every launch mints a fixed 1,000,000,000-token supply (18 decimals) into a **standard Uniswap v3 pool at the 1% fee tier** as a single-sided position, in the same transaction as token creation. There is no bonding curve, no internal ledger, no pre-graduation market, and no curve→AMM migration. The position NFT is transferred into `ArchLiquidityVault`, where principal withdrawal is impossible forever.

## Rationale

- Verified Envelope parity: "There is no custom AMM, no bonding curve, and no proxy" (VERIFIED_FROM_DOCS).
- A real v3 pool from block one means all standard tooling (routers, aggregators, indexers) works immediately, and "graduation" can honestly be a UI-only milestone.

## Key math obligations

- Starting price targets ≈ $3,000 market cap → ≈ $0.000003/token with a 6-decimal quote: raw price token1/token0 depends on address ordering; `sqrtPriceX96`, tick range, and liquidity are derived with exact integer math and tested for **both** token0/token1 orderings.
- The single-sided range must place all 1e27 raw token units on the token side at initialization; tests assert zero quote-side principal at creation and full supply accounting.

## Consequences

Buys deposit quote asset into the locked position (price up); sells do the reverse. LP fees are the only extractable value: token-side burned, quote-side split 30/70 creator/protocol (ADR 0004).
