# Mainnet launch runbook (Path A: Base mainnet ⟷ chain 5042)

Everything is prepared and the deploy is a single proven command. What remains
is **funding the operator wallet** and pulling the trigger.

Operator wallet: `0x8fA45d6cA2D97fcfa7496C4D34647EC3CBB48764`
(hot; capped-beta deployer + owner + keeper + relayer. Key stored git-ignored in
`.env.mainnet`. Fees never route here — they go to your 5 wallets.)

## Step 1 — Fund the operator wallet (you)

| Chain | Asset | Amount | Purpose |
|---|---|---|---|
| Base mainnet | ETH | ~$10 | gas to deploy the Base vault + splitter, and run the keeper |
| Base mainnet | USDC | ~$30–50 | the canary deposit (comes back to you) |
| Chain 5042 | native USDC (gas) | ~$5 | gas to deploy the whole Arc stack (~$0.70) + keeper/relayer ops |

Getting USDC onto chain 5042: bridge real USDC there via Circle CCTP or the
same route Envelope uses (its bridge / an exchange that supports Arc). Deploying
the full stack costs well under $1 in 5042 gas.

Tell me once the operator wallet shows a few dollars of USDC on 5042 and some
ETH + USDC on Base — I verify on-chain before spending anything.

## Step 2 — Confirm fee numbers (you, one line)

`.env.mainnet` is currently set to **Envelope's exact live numbers**: 10% deposit
fee, 35% creator share, 50-unit launch fee. Say "keep Envelope numbers" or give
me overrides.

## Step 3 — Deploy (me, one command)

```sh
node scripts/deploy-arch.mjs .env.mainnet
```

This deploys, in order and idempotently (proven on testnet):
Base: fee splitter → vault (fee to splitter) → keeper.
Chain 5042: fee splitter → aUSD → bridge (+BRIDGE_ROLE, keeper) → gas station
(+relayer, action budgets) → liquidity vault → factory (launch fee to splitter)
→ fee distributor (protocol 65% to splitter) → graduation registry → wire vault
fee distributor. Writes `deployed-addresses.5042.json` and the Vercel env block.

## Step 4 — Wire fees + fund gas station (me)

```sh
node scripts/set-fee-recipients.mjs set <your 5 wallets> --weights 4000,1500,1500,1500,1500
# then send ~$3 native USDC into the gas station for drip inventory
```

## Step 5 — Point production at mainnet (me)

- Vercel: set the `NEXT_PUBLIC_ARCH_*` block the deploy printed (+ `NEXT_PUBLIC_ARC_RPC_URL=https://5042.rpc.thirdweb.com`, `NEXT_PUBLIC_BASE_RPC_URL=https://mainnet.base.org`), redeploy.
- Railway: update the worker/indexer env to the mainnet addresses + `ARC_RPC_SERVER_URL=https://5042.rpc.thirdweb.com` + `BASE_SEPOLIA_RPC_URL`→ mainnet. Redeploy.

## Step 6 — Canary (me, real money, small)

Deposit 25 USDC on Base → confirm the worker mints ~22.5 aUSD on 5042 → redeem
5 aUSD → confirm ~5 USDC released on Base. Verify reserve == supply. Only after
this passes:

## Step 7 — Open (you say go)

Flip `ENABLE_REAL_BRIDGE=true`, announce controlled beta, and launch your first
token yourself through the live Create page.

## Standing risks you've accepted (Path A)

- Unaudited contracts holding user funds (mitigated by the $100 deposit cap +
  pauses + 81 tests, not eliminated).
- Chain 5042 is not officially branded Arc mainnet by Circle.
- Single hot operator key for capped beta (separate into a multisig + distinct
  keepers before raising caps).
