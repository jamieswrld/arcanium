# Milestone 3 — Bridge services (completed 2026-07-29)

## 1. Files created/changed

- `packages/abis/src/arch.ts` — ABIs generated from Foundry artifacts (ArchUSD, ArchVaultBase, ArchBridgeArc).
- `packages/sdk/src/bridge.ts` — `bridgeActionId` (must match on-chain `keccak256(abi.encode(txHash, logIndex))`), bridge state types.
- `apps/bridge-worker/src/main.ts` — deposit worker: chunked+paced `eth_getLogs` polling, confirmation depth, reorg re-verification, on-chain `processedDeposits` as the authoritative replay barrier, exact-net minting.
- `apps/redeem-worker/src/main.ts` — redemption worker: same pattern against `Redeemed`/`processedRedemptions`, tuned to Arc RPC rate limits (shallow lookback, 900-block chunks, 1s pacing).
- `apps/api/src/main.ts` — `POST /v1/bridge/quote` (live vault reads), `GET /v1/bridge/actions/:actionId` (status proven against processed mappings), `GET /v1/bridge/address/:address` (event reconstruction), `/v1/platform/config`.
- `apps/web` — wagmi + react-query providers; `WalletButton`/`NetworkPill` (EIP-6963 injected discovery); `BridgeWidget` (full state machine: disconnected → wrong network → approval → signature → source pending → destination pending → completed/error, live fee/limit/balance reads, Max, direction switch, explorer links, completion only on destination proof); `BridgeHistory` (on-chain reconstruction with destination-proven statuses); webpack aliases for broken optional `@x402/*` deps.

## 2. Architecture

Chain-first safety: workers are stateless-safe — the contracts' processed-ID mappings prevent double mint/release no matter how workers crash, restart, or race. The DB layer (schema from M1) remains an additive cache; not required for correctness. The UI never treats a source receipt as completion — it polls the destination chain's processed mapping.

## 3–4. Tests / validation

- `pnpm build` 14/14; `forge test` 45/45 (unchanged).
- **Live validation on real testnets (2026-07-29):**
  - Deposit `0xa2fc5e87…b4d190` (2 USDC, fee 0.3, net 1.7) → bridge-worker autonomously minted 1.7 aUSD on Arc (`0x0926f378…d049bc`) after 10 confirmations.
  - Redemption `0x5477c796…7c199d` (1 aUSD burn) → redeem-worker autonomously released 1 USDC on Base (`0xe8f2455c…7d9ee1`).
  - Final books: reserve 12.7 USDC == supply 12.7 aUSD.
- Production deploy: https://arclaunchpad-eight.vercel.app (wallet-enabled).

## 5. Known assumptions / divergences

- BullMQ/Redis queueing and Postgres persistence deferred (documented divergence): current workers derive all state from chain with bounded lookback; dead-letter + reconciliation tooling comes with the DB layer in hardening (M9). Public Arc testnet RPC rate limits shaped worker pacing; production should use a dedicated RPC.
- WalletConnect mobile pairing requires a WalletConnect Cloud project id (not yet provisioned); injected wallets (MetaMask/Rabby/Coinbase/Rainbow extensions) work via EIP-6963.
- Workers currently run on the developer machine; they must move to a small VPS for continuous operation (cost sheet line item).

## 6. Security

Keeper key = deployer key on testnet only. On-chain caps bound worker damage. No keys in frontend env (worker keys live in `.env`, git-ignored, server-side only).

## 7. Environment variables

Workers: `ARCH_VAULT_BASE_ADDRESS`, `ARCH_BRIDGE_ARC_ADDRESS`, `ARC_KEEPER_PRIVATE_KEY`, `BASE_KEEPER_PRIVATE_KEY`, RPC URLs, confirmation counts. Web adds: `NEXT_PUBLIC_BASE_USDC_ADDRESS` (optional override).

## 8. Run locally

```sh
pnpm build
node apps/bridge-worker/dist/main.js   # deposit → mint
node apps/redeem-worker/dist/main.js   # burn → release
node apps/api/dist/main.js             # REST on :4000
pnpm --filter @arch/web dev
```

## 9. Remaining parity gaps

Gas station (M4) — including the inline no-gas fallback in the bridge flow; launchpad (M5–M7); indexer/candles (M6); migration (M8); hardening: DB persistence, queues, reconciliation tooling, multisig/timelock, monitoring (M9).
