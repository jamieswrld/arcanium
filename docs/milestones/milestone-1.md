# Milestone 1 — Research and skeleton (completed 2026-07-28)

## 1. Files created

83 files. Highlights:

- `docs/research/envelope-parity-report.md` — full parity research with per-item `VERIFIED_FROM_DOCS` / `VERIFIED_ONCHAIN` / `VERIFIED_IN_UI` / `INFERRED` / `UNKNOWN` statuses.
- `docs/adr/0001…0006` — monorepo/stack, bridged-dollar-not-CCTP, direct-Uniswap-v3, fee configuration, no-proxies, network gating + wind-down.
- `docs/security/threat-model.md`, `docs/architecture.md` (mermaid system diagram).
- Root: `package.json`, `pnpm-workspace.yaml`, `turbo.json`, `tsconfig.base.json`, `.env.example`, `.github/workflows/ci.yml`.
- `packages/config` (zod-typed env, bigint-safe fees, feature gates), `packages/chain-config` (four env-driven network profiles, Arc 18d/6d gas utilities), `packages/database` (migration `0001_initial.sql` + client + runner), `packages/sdk` (exact decimal math + tests), `packages/ui` (Arch design tokens + Card/Badge/StatRow), `packages/abis`, `packages/testing`, `packages/contracts` (Foundry config; contracts land M2).
- `apps/web` (static Next.js App Router shell: `/`, `/tokens`, `/tokens/[address]`, `/create`, `/gas`, `/portfolio`, `/docs`), plus six service skeletons (`api`, `indexer`, `bridge-worker`, `redeem-worker`, `gas-relayer`, `admin`).
- `infra/docker-compose.yml` (Postgres 16, Redis 7, MinIO, two anvil chains).

## 2. Architecture implemented

Monorepo with strict-TS workspaces; typed env as the only configuration path; env-driven chain profiles with `arcMainnet` structurally gated; DB schema for bridge actions (10-state machine), gas quotes/drips, tokens, swaps, candles (6 intervals), fee distributions, holders, reorg-aware cursors, append-only audit log, dead letters; bridge-first frontend with all mandated fee disclosures in static form; services that validate config on boot and refuse real-funds modes they don't implement.

## 3. Tests added

`packages/sdk` decimal suite: parse/format round-trips, precision rejection, malformed-input rejection, exact 15% fee math, exact 30/70 split.

## 4. Tests passing

- `pnpm build` — 14/14 tasks (including `next build`).
- `pnpm typecheck` — 19/19 tasks.
- `pnpm --filter @arch/sdk test` — 6/6 pass.
- Smoke: `indexer` and `bridge-worker` skeletons load env and exit 0; `bridge-worker` exits fatally if `ENABLE_REAL_BRIDGE=true` (by design).

## 5. Known assumptions

See parity report §10. Key: Arc "mainnet" chain 5042 is evidence from Envelope's deployment, not official confirmation — `arcMainnet` stays env-only and disabled; Envelope's UI states/modals/mobile behavior are largely INFERRED/UNKNOWN (SPA not fully observable), so Arch implements its own fully-specified state machine; creator initial purchase is an Arch feature not verified as Envelope parity; Envelope launch fee 50 units and deposit fee 10% were verified on-chain 2026-07-28 (values can change — re-verify at later milestones).

## 6. Security concerns

Bridge solvency invariant is the crown jewel (threat model A1/A2); no keys exist anywhere in this milestone; all real-funds gates default off and services enforce them; the admin reconciliation path must remain evidence-required when built; Envelope-style proxy pattern deliberately rejected (ADR 0005).

## 7. Environment variables required

See `.env.example` (complete annotated set). Nothing is required to build; `DATABASE_URL` for migrations; RPC URLs per network to run services against chains.

## 8. Run locally

```sh
corepack enable && pnpm install
cp .env.example .env
pnpm infra:up
pnpm db:migrate
pnpm build && pnpm test
pnpm --filter @arch/web dev   # http://localhost:3000
```

## 9. Deploy to testnet

Nothing deployable exists yet by design (contracts are Milestone 2). When they land: `cd packages/contracts && forge install foundry-rs/forge-std OpenZeppelin/openzeppelin-contracts && forge script script/DeployBridge.s.sol --rpc-url base_sepolia --broadcast` (script names finalized in M2). No real funds pending the full launch gate.

## 10. Remaining parity gaps

All of Milestones 2–9: contracts, workers, bridge API + frontend wiring, gas station, launchpad contracts, indexer/API, launchpad frontend, migration, hardening. Research gaps to close during implementation: Envelope bridge/gas API response schemas (UNKNOWN — Arch defines its own), full sort/interval sets (INFERRED), portfolio/gas page contents (UNKNOWN), Arc testnet Uniswap v3 deployment (must locate officially or deploy our own), official Arc mainnet parameters (blocking `ENABLE_ARC_MAINNET`).
