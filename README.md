# Arch

> The aUSD bridge and fair-launch token platform for Arc.

Bridge USDC to Arc. Launch a token. Trade immediately through permanently locked Uniswap liquidity.

Arch is a clean-room implementation of the product mechanics publicly documented by Envelope, with original branding, code, copy, and deployments. See `docs/research/envelope-parity-report.md` for what is verified versus inferred, and `docs/adr/` for the decisions (including intentional divergences: 15% deposit fee, 30/70 fee split, 52.5-unit launch fee).

## Layout

```text
apps/web              Next.js frontend (bridge-first, launchpad, create, gas, portfolio, docs)
apps/api              Public REST API (OpenAPI)
apps/indexer          Arc event and pool indexer (bigint-exact pricing, candles)
apps/bridge-worker    Base deposit → Arc mint worker
apps/redeem-worker    Arc burn → Base release worker
apps/gas-relayer      Permit-based Arc gas relayer
apps/admin            Restricted operational dashboard

packages/contracts    Foundry Solidity project
packages/abis         Generated ABIs
packages/chain-config Base and Arc network definitions (env-driven)
packages/database     PostgreSQL schema, migrations, client
packages/sdk          Public TypeScript SDK (exact decimal math)
packages/ui           Shared design system
packages/config       Typed environment configuration (zod)
packages/testing      Fixtures and test utilities
```

## Getting started

```sh
corepack enable                      # provides pnpm
pnpm install
cp .env.example .env                 # then fill in RPC URLs
pnpm infra:up                        # postgres, redis, minio, two anvil chains
pnpm db:migrate
pnpm build
pnpm dev                             # or: pnpm --filter @arch/web dev
```

Contracts (after installing Foundry):

```sh
cd packages/contracts
forge install foundry-rs/forge-std OpenZeppelin/openzeppelin-contracts
forge build && forge test
```

## Safety posture

`ENABLE_ARC_MAINNET`, `ENABLE_REAL_BRIDGE`, and `ENABLE_REAL_TRADING` default to `false` and stay that way until the address book is verified against official Arc, Circle, and Uniswap sources and the full launch gate (audit, solvency review, bug bounty, rehearsed incident response) passes. Services refuse to start in real-funds modes they don't implement.

aUSD is issued by Arch, not Circle, and is not native USDC. It is backed one-for-one (after the 15% deposit fee) by USDC held in the Arch vault on Base, and becomes exchangeable one-for-one for native USDC when Circle's bridge reaches Arc.
