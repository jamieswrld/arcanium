# ADR 0002 — Temporary bridged dollar (aUSD) instead of CCTP/native USDC

Status: Accepted · Date: 2026-07-28

## Decision

Arch launches with its own bridged dollar, **Arch USD (aUSD, 6 decimals)**, minted on Arc against a Base USDC reserve held in `ArchVaultBase`, exactly mirroring Envelope's initial architecture. CCTP / native-USDC bridging is explicitly **not** used at launch, even where it would be simpler.

## Rationale

- Product mandate: Arch must be operationally equivalent to Envelope's complete initial architecture, including the temporary bridged dollar and its eventual one-for-one wind-down into native USDC.
- The wind-down path (pause deposits → prove full collateralization → move reserve → open permanent 1:1 exchange → migrate pools) is a first-class designed feature, not an afterthought (see ADR 0006).

## Consequences

- Arch carries issuer risk and must disclose prominently: aUSD is issued by Arch, not Circle; it is not native USDC.
- The solvency invariant `Base net reserve ≥ outstanding aUSD supply` is the system's most important property; it is enforced in contracts, monitored by the admin dashboard, and covered by Foundry invariant tests.
- Asynchronous mint/release workers, reorg handling, idempotency locks, and a status API are required infrastructure from day one.
