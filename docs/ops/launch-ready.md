# Arch — launch-ready state (pure Arc, zero Envelope)

Decision (2026-07-29): deploy Arch as a native Arc project the moment Circle's
**official Arc mainnet** opens, using Arc's own rails (CCTP for gas). No Envelope
contracts, bridge, or gas station in the live product. The Envelope bootstrap is
abandoned.

## Parked, recoverable

- ~22.5 eUSD sits in the operator wallet on chain 5042 from the one bootstrap
  deposit. It is backed by our 25 USDC in Envelope's Base vault and is
  recoverable (redeem → Base USDC) whenever we have 5042 gas — e.g. at official
  mainnet. Not lost; just illiquid until then. Sunk cost so far: the ~$2.50
  Envelope deposit fee.
- Operator wallet `0x8fA45d6cA2D97fcfa7496C4D34647EC3CBB48764`:
  ~$161 USDC + ~0.0098 ETH on Base mainnet, untouched and safe.

## Everything is built and proven

- Contracts: 81/81 Foundry tests. Full stack (bridge, gas station, launchpad,
  migration, fee splitter). Fees: 10% deposit, 10% creator / 90% protocol, all
  protocol fees → your 5-wallet splitter (40/15/15/15/15).
- One-command deploy `scripts/deploy-arch.mjs` — proven end-to-end on testnet.
- Frontend live on Vercel; workers + indexer live on Railway; testnet contracts
  live. This is the public demo until mainnet.

## What fires the instant official Arc mainnet opens

1. Verify official params from Circle/Arc docs: mainnet chain ID, RPC, explorer,
   USDC address, and the canonical Uniswap v3 deployment. Update `.env.mainnet`
   (`ARC_MAINNET_*`, `UNISWAP_V3_*`).
2. Get gas the Arc way: CCTP a few dollars of USDC from Base → native USDC on Arc
   (works once mainnet is open — no Envelope).
3. `node scripts/deploy-arch.mjs .env.mainnet` — full stack, Base mainnet + Arc,
   capped beta.
4. `node scripts/set-fee-recipients.mjs set <5 wallets> --weights 4000,1500,1500,1500,1500`
5. Fund the Arch gas station with a few dollars of native USDC.
6. Point Vercel (`NEXT_PUBLIC_ARCH_*`) and Railway (worker/indexer addresses +
   mainnet RPCs) at the new deployment; redeploy.
7. Canary: 25 USDC deposit → mint → redeem 5 → release; verify reserve = supply.
8. Flip `ENABLE_REAL_BRIDGE=true`; you launch the first token yourself.

## Open trigger

Watching for: Circle's official statement that Arc mainnet is public + published
mainnet chain ID / RPC / USDC. Until then, nothing deploys to real funds and the
config gates (`ENABLE_ARC_MAINNET` verification) hold.
