# ADR 0005 — No upgradeable proxies

Status: Accepted · Date: 2026-07-28

## Decision

No Arch contract uses an upgradeable proxy. Launch tokens are immutable by product definition; core protocol contracts (vault, bridge, gas station, factory, liquidity vault, fee distributor, graduation registry, migration contracts) are deployed as plain implementations. Evolution happens through explicit, event-emitting migration paths (e.g. the vault's `migrationTarget` with pause-gated hand-off), not storage-preserving upgrades.

## Rationale

- The system's core promise — permanently locked liquidity, a reserve that can only move via a visible migration, one-for-one redemption — is only credible if no admin can swap implementation code underneath it.
- Envelope's factory bytecode suggests it sits behind a proxy (VERIFIED_ONCHAIN bytecode, INFERRED interpretation). Arch deliberately diverges: the coding rules require a written security justification for any proxy, and none clears the bar against the trust cost.

## Consequences

Bug response relies on: pausability of every flow, conservative rate caps, the explicit migration path, and (worst case) deploying replacement contracts plus a public migration. This is accepted.
