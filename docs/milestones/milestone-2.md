# Milestone 2 — Bridge contracts (completed 2026-07-29)

## 1. Files created

- `packages/contracts/src/bridge/ArchUSD.sol` — aUSD: ERC-20 + EIP-2612, BRIDGE_ROLE-only mint/burn, pausable, 6 decimals, no admin mint path.
- `packages/contracts/src/bridge/ArchVaultBase.sol` — deposit with 15% visible fee (hard cap 20%), reserve accounting, replay-proof capped `release`, pause flags, two-step ownership, keeper role, USDC-excluded rescue, pause-gated `migrateReserve`.
- `packages/contracts/src/bridge/ArchBridgeArc.sol` — keeper-driven replay-proof `mintDeposit` with per-tx/per-window caps; free 1:1 `redeem` burning only `msg.sender` with monotonic nonce.
- Tests: `ArchUSD.t.sol`, `ArchVaultBase.t.sol`, `ArchBridgeArc.t.sol`, `BridgeInvariant.t.sol` (adversarial handler: out-of-order processing, replay attempts, pause toggling, clock skew), `mocks/MockUSDC.sol` (test-only stand-in; the deployed system touches only real Circle USDC).
- Scripts: `DeployVaultBase.s.sol`, `DeployBridgeArc.s.sol` — fully env-driven, two-step ownership hand-off to the multisig, deployer renounces aUSD roles.

Also this session: parity report §8 updated with screenshot-verified UI; web app rebuilt to the observed Envelope structure; live on-chain reads (`apps/web/src/lib/onchain.ts`); production deploy to Vercel.

## 2. Architecture implemented

Both replay barriers are **on-chain** (processed-ID mappings keyed by `keccak256(abi.encode(txHash, logIndex))`), so no worker bug can double-mint or double-release. Rate caps per tx and per rolling window on both mint and release. aUSD supply can only change through the bridge contract.

## 3. Tests added

45 Foundry tests: 20 vault, 12 bridge, 8 aUSD (incl. EIP-2612 permit signature test), 5 invariants.

## 4. Tests passing

`forge test`: **45/45**. Invariants (256 runs × depth 64, ~2,000 calls/handler-fn): reserve ≥ supply; reserve == vault balance; mints ≤ net deposits; releases ≤ burns; supply == mints − burns.

## 5. Known assumptions

Base Sepolia USDC `0x036CbD53842c5426634e7929541eC2318f3dCF7e` (Circle's published testnet address — re-verify at developers.circle.com before funding). Testnet phase uses one deployer address for all roles; role separation is mandatory before any mainnet use. The deployer key was generated in-session → **testnet-only forever**.

## 6. Security concerns

Owner is a plain EOA on testnet (multisig + timelock required for mainnet). `migrateReserve` is owner-gated + pause-gated but not yet timelocked (timelock wiring in M9 hardening). Worker liveness is not a safety property (chain state is), but is an availability property to monitor.

## 7. Environment variables required

Deploy: `DEPLOYER_PRIVATE_KEY`, `VAULT_USDC_ADDRESS`, `VAULT_OWNER_ADDRESS`, `VAULT_TREASURY_ADDRESS`, `VAULT_KEEPER_ADDRESS`, fee/limit vars; Arc side: `ARC_ADMIN_ADDRESS`, `ARC_KEEPER_ADDRESS`, `BRIDGE_MIN_REDEEM_UNITS`, mint-cap vars. Web live reads: `NEXT_PUBLIC_BASE_RPC_URL`, `NEXT_PUBLIC_ARC_RPC_URL`, `NEXT_PUBLIC_ARCH_VAULT_BASE_ADDRESS`, `NEXT_PUBLIC_ARCH_USD_ADDRESS`.

## 8. Run locally

```sh
cd packages/contracts
forge build && forge test
```

## 9. Deploy to testnet (after funding 0x5825…816a via faucets)

```sh
cd packages/contracts
# Base Sepolia (needs Base Sepolia ETH for gas):
forge script script/DeployVaultBase.s.sol --rpc-url https://sepolia.base.org --broadcast
# Arc testnet (needs Arc testnet USDC for gas, from faucet.circle.com):
forge script script/DeployBridgeArc.s.sol --rpc-url https://rpc.testnet.arc.network --broadcast
# Then set NEXT_PUBLIC_ARCH_VAULT_BASE_ADDRESS / NEXT_PUBLIC_ARCH_USD_ADDRESS
# in Vercel project settings and redeploy: vercel deploy --yes --prod
```

## 10. Remaining parity gaps

Milestones 3–9 (workers, bridge API/frontend wiring, gas station, launchpad, indexer, migration, hardening). Timelock + multisig wiring. Contract verification on explorers post-deploy.
