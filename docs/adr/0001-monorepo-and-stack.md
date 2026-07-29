# ADR 0001 — Monorepo, toolchain, and service decomposition

Status: Accepted · Date: 2026-07-28

## Decision

One pnpm + Turborepo monorepo containing seven deployable apps (`web`, `api`, `indexer`, `bridge-worker`, `redeem-worker`, `gas-relayer`, `admin`) and nine shared packages (`contracts`, `abis`, `chain-config`, `database`, `sdk`, `ui`, `config`, `testing`). Solidity lives in a Foundry project (`packages/contracts`); everything else is strict-mode TypeScript.

## Rationale

- The bridge is two independent trust-critical loops (deposit→mint, burn→release). Separate workers mean one loop can be paused, crashed, or redeployed without touching the other, and each holds only the key material it needs (Arc minter key vs Base keeper key).
- The gas relayer holds a hot wallet and takes untrusted input (signatures); isolating it limits blast radius.
- Shared bigint decimal utilities, chain config, and generated ABIs must be single-sourced — a monorepo makes drift impossible.
- Turborepo gives cached, dependency-ordered `build`/`lint`/`test` pipelines in CI.

## Consequences

Single deploy artifact per app; `packages/config` is the only way any app reads environment; no app imports another app.
