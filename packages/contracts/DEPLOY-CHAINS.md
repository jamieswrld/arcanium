# Deploying Arcanium to a new chain

Factory v5 derives its launch price from the quote token's decimals, so the same
bytecode produces an identical $3,000-cap launchpad on every chain. Adding a
chain is: fund the deployer → run one command → paste three addresses into env.

Verified on live mainnet forks (`test/launchpad/MultiChainLaunch.t.sol`):

| Chain | Quote | Decimals | Launch cap | Tokens per $100 |
| --- | --- | --- | --- | --- |
| Robinhood (4663) | USDG | 6 | $2,999 | 31,639,932 |
| BNB (56) | USDT | 18 | $2,999 | 31,407,996 |

## 1. Fund the deployer

`DEPLOYER_ADDRESS` needs native gas on the target chain. Deployment is cheap:

| Chain | Gas needed | Approx |
| --- | --- | --- |
| Robinhood | 0.00051 ETH | ~$2 |
| BNB | 0.00046 BNB | ~$0.40 |

Leave headroom — send ~0.005 ETH / ~0.01 BNB.

## 2. Deploy

Run from `packages/contracts`. **Both overrides below matter**: the repo `.env`
carries Arc-era values that are wrong for a new chain.

- `PAIR_FEE_CREATOR_SHARE_BPS=1000` — 10% creator / 90% protocol. The `.env`
  default is 3000 (an older split).
- `unset GRADUATION_QUOTE_UNITS` — let the script scale 9,000 to the quote
  asset's decimals. The `.env` value is `9e9` (9,000 at 6dp); reusing it on an
  18-decimal quote would mark every token graduated the moment it launched.

```bash
cd packages/contracts
set -a; . ../../.env; set +a
unset GRADUATION_QUOTE_UNITS
export PAIR_FEE_CREATOR_SHARE_BPS=1000

# --- Robinhood Chain (4663) — USDG, 6dp ---
UNISWAP_V3_POSITION_MANAGER_ADDRESS=0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3 \
UNISWAP_V3_SWAP_ROUTER_ADDRESS=0xCaf681a66D020601342297493863E78C959E5cb2 \
QUOTE_TOKEN_ADDRESS=0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168 \
forge script script/DeployChain.s.sol:DeployChain \
  --rpc-url https://rpc.mainnet.chain.robinhood.com --broadcast

# --- BNB Chain (56) — USDT, 18dp ---
UNISWAP_V3_POSITION_MANAGER_ADDRESS=0x7b8A01B39D58278b5DE7e48c8449c9f4F5170613 \
UNISWAP_V3_SWAP_ROUTER_ADDRESS=0xB971eF87ede563556b2ED4b1C0b0019111Dd85d2 \
QUOTE_TOKEN_ADDRESS=0x55d398326f99059fF775485246999027B3197955 \
forge script script/DeployChain.s.sol:DeployChain \
  --rpc-url https://bsc-dataseed.bnbchain.org --broadcast
```

Drop `--broadcast` to dry-run first; it prints the same figures and spends
nothing. Confirm `quote decimals`, `graduation units` and `creator share bps`
in the output before broadcasting.

## 3. Wire the site

The script prints the three addresses. Put them in `apps/web/.env.local`:

```bash
NEXT_PUBLIC_ROBINHOOD_FACTORY_ADDRESS=0x...
NEXT_PUBLIC_ROBINHOOD_LIQUIDITY_VAULT_ADDRESS=0x...
NEXT_PUBLIC_ROBINHOOD_MODE_DISTRIBUTOR_ADDRESS=0x...

NEXT_PUBLIC_BNB_FACTORY_ADDRESS=0x...
NEXT_PUBLIC_BNB_LIQUIDITY_VAULT_ADDRESS=0x...
NEXT_PUBLIC_BNB_MODE_DISTRIBUTOR_ADDRESS=0x...
```

A chain flips from "Coming soon" to live in the switcher as soon as its
`_FACTORY_ADDRESS` is set (`live` is derived from it in `lib/chains.ts`).

Optional private/paid RPCs, server-side only, tried ahead of the public list:
`ROBINHOOD_RPC_URLS`, `BNB_RPC_URLS` (comma-separated).

## 4. Verify with a real launch

Do one small launch per chain before announcing, exactly as we did on Arc:

1. Launch a token with a tiny creator buy.
2. Check the pool opened near $3,000 FDV — not $3 and not $3 trillion. A decimals
   mistake shows up here as a ~1e12 error, nowhere subtler.
3. Buy, then sell, and confirm fees accrue to the vault.
4. Run `distribute()` and confirm the 90/10 split lands in the right wallets.

## Adding a further chain

1. Confirm Uniswap v3 is deployed and `feeAmountTickSpacing(10000)` returns 200.
2. Confirm the quote asset has **6 or 18 decimals** — v5 reverts on anything
   else rather than mispricing a pool.
3. Add an entry to `CHAINS` in `apps/web/src/lib/chains.ts`.
4. Add a fork test case to `MultiChainLaunch.t.sol` and make it pass.
5. Follow steps 1–4 above.
