# Getting Arcanium indexed by aggregators

Runbook. Everything here is a form, an email or a pull request — none of it
needs a code change on our side.

## Why the third-party tools are wrong about us

Two symptoms, one cause each, and neither is a defect in our tokens:

- **gmgn: "No Available Router."** Aggregators hardcode router addresses per
  chain. Arc's Uniswap is a fork at non-canonical addresses, so gmgn cannot
  build a route even though the pool trades normally.
- **fomo: "Zero liquidity — creator has removed liquidity."** A false positive.
  Scanners compute liquidity as USD TVL, and an Arcanium launch is single-sided:
  the quote side starts near zero and fills as people buy. A fresh launch holds
  ~1B tokens and a few dollars of USDC, which reads as an empty pool. Verified
  on-chain: `pool.liquidity()` is non-zero and identical across launches, and
  the position is locked.

Neither is fixable by changing our contracts. Both are fixed by the platforms
having Arc's addresses.

## The data pack

Everything any of these will ask for. All verified on-chain.

| Field | Value |
|---|---|
| Chain name | Arc |
| Chain ID | 5042 |
| Native currency | USDC (18 decimals) |
| RPC | `https://rpc.quicknode.mainnet.arc.io` |
| RPC (fallback) | `https://rpc.arc-scan.org` |
| Block time | ~0.506 s |
| Multicall3 | `0xcA11bde05977b3631167028862bE2a173976CA11` |
| DEX | Uniswap v3 fork |
| Uniswap v3 factory | `0xf0db7b58379503491d857dB50AC9ece64c653918` |
| NonfungiblePositionManager | `0x39654A85A4C05127f5Fd6ED22CAeC077A0fB1377` |
| SwapRouter02 | `0x4C91c54E60B59b1F949Af57064EA70bD73434720` |
| Quote asset (native USDC) | `0x3600000000000000000000000000000000000000` (6 dec) |
| Pool fee tier used | 10000 (1%), tickSpacing 200 |
| Uniswap factory deployed at block | 1,948,019 |
| Position manager deployed at block | 1,948,053 |
| SwapRouter02 deployed at block | 11,912,287 |
| Project | Arcanium — <https://arcanium.trade> |
| Launchpad factory (current, v4) | `0x8e5732B520a318251a702a680AA7F123fb92AF52` |
| Launchpad v1 deployed at block | 12,775,070 |
| Launchpad v4 deployed at block | 12,954,132 |

**Block explorer is an open question.** `arc-mainnet.cloud.blockscout.com` is a
dead vhost (404 at every path) and `explorer.arc.io` sits behind Circle's
Cloudflare Access. Every form below asks for an explorer URL, so settle this
first — see the note at the bottom.

## Priority order

Do them in this order; the first one cascades furthest.

### 1. GeckoTerminal — highest leverage, free

GeckoTerminal indexes DEXes per chain and feeds CoinGecko and a long tail of
downstream tools. It explicitly supports Uniswap v3 forks, and listing is free.

- Submission: the request form linked from the bottom-right of
  <https://geckoterminal.com>, and from CoinGecko's support article
  ["How do I get my EVM Chain/DEX listed on GeckoTerminal?"](https://support.coingecko.com/hc/en-us/articles/22611672824473-How-do-I-get-my-EVM-Chain-DEX-listed-on-GeckoTerminal)
- Check ["DEX Forks supported by GeckoTerminal"](https://support.coingecko.com/hc/en-us/articles/31990086551321-DEX-Forks-supported-by-GeckoTerminal)
  first and name our fork as Uniswap v3 so it maps to a known template.
- Needs the whole data pack above. Arc itself likely has to be added as a chain
  in the same request.

### 2. DefiLlama — a pull request we can write ourselves

DefiLlama adapters are open source, so this is the one item here that is code
rather than a form, and it does not depend on anyone's review queue beyond a
normal PR.

There is a close precedent:
[PR #20970](https://github.com/DefiLlama/DefiLlama-Adapters/pull/20970) added
PheraDEX — a concentrated-liquidity DEX *and token launchpad* on a new chain,
using Uniswap-v3-shaped `PoolCreated` events — merged 2026-09-10.

Shape, per that PR:

```
projects/arcanium/index.js        # adapter
registries/uniswapV3.js           # register the deployment
```

**Do not point the entry at the Uniswap factory.** That factory was deployed at
block 1,948,019 — roughly 10.8M blocks before our first launchpad — so it is
Arc's shared Uniswap deployment, not ours. Registering it as "Arcanium" would
attribute every Uniswap pool on Arc to us, which is both wrong and the sort of
thing that gets a PR rejected.

The adapter has to enumerate Arcanium's own launches and sum only their pools.
The launchpad factories expose `allTokensLength()` / `allTokens(i)`, and
`launches(token)` returns the pool, so the pool set can be built by direct calls
with no logs at all. That matters here: Arc's public RPCs prune logs after a few
days, so a log-based adapter would silently stop seeing early launches.

Walk all four generations, newest first:

```
0x8e5732B520a318251a702a680AA7F123fb92AF52  (v4, block 12,954,132)
0xE2aA88806872C2a02A4ab439584d457002983600  (v3)
0xA024664AD5d30F3c0b18b931DdB6f64A96DE8ED3  (v2)
0x1d65ab4cDCDdA6f38A9c93a24EF64bE8905e19d5  (v1, block 12,775,070)
```

`fromBlock: 12775070` is the correct lower bound — no Arcanium pool can predate
the first launchpad.

One judgement call to make before submitting: an Arcanium pool holds ~1B of its
own token plus the quote side. Counting the token side values a launch at its
own market price, which is circular and inflates TVL. Quote-side only is the
defensible figure, and is what the `methodology` string should say.

- Docs: [How to list a DeFi project](https://docs.llama.fi/list-your-project/submit-a-project)
  and [How to write dimensions adapters](https://docs.llama.fi/list-your-project/other-dashboards)
- Repo: <https://github.com/DefiLlama/DefiLlama-Adapters>
- There is a `uniV3Exports` helper for exactly this shape — use it rather than
  hand-rolling TVL.
- **Prerequisite:** Arc must exist in DefiLlama's chain list. If it does not,
  that is a separate addition and has to land first.
- After merge, allow ~24h for the front end to pick it up. No need to chase the
  PR; they are monitored.

### 2b. List Arc's Uniswap deployment, not just Arcanium

Worth separating, because it is the half that actually fixes gmgn.

The factory at `0xf0db7b58…` predates our launchpad by ~10.8M blocks, and its
`owner()` is `0xbCA30b5429935205037069cF5b8A165F55d05a75` — not our deployer. So
it is Arc's own Uniswap v3 deployment, which everything on Arc trades through,
and it appears to be unlisted everywhere. That, not anything about Arcanium, is
why routers have no route.

Be straight about this in every submission: **Arcanium is a launchpad built on
Arc's Uniswap v3, not a DEX of its own.** Presenting the factory as ours would
be both untrue and the fastest way to get a submission rejected — these teams
check `owner()`.

So there are two distinct asks, and they go to the same places:

1. **Index the DEX** — Arc + its Uniswap v3 fork, so any aggregator can route
   any Arc pool. Fixes "No Available Router" for every Arcanium token at once,
   and for everyone else on Arc.
2. **List Arcanium** — the launchpad, as a protocol with its own TVL.

Ask for the first. The second is far less useful without it.

### 3. DexScreener

Chain integrations are handled by request, not self-serve.

- Primary channel: their Discord. Secondary: `support@dexscreener.com`.
- [Help centre](https://help.dexscreener.com/en/categories/289345)
- They weigh chain activity, so this one is easier once there is more volume —
  worth doing after GeckoTerminal rather than before.

### 4. gmgn and fomo

These are the two that prompted this. Both are smaller and neither documents a
public listing process, so the channel is their Telegram or X support account.

What to send: the data pack, and specifically that the router is
`0x4C91c54E60B59b1F949Af57064EA70bD73434720` — the "No Available Router" error
is exactly the missing piece.

For fomo's "zero liquidity" warning, ask them to price the token side of a
single-sided v3 position rather than reading quote-side TVL only, and point at
`pool.liquidity()` being non-zero as the check that distinguishes a locked
single-sided launch from an actual rug.

## Settle the explorer first

Every form asks for one, and ours is broken:

- `arc-mainnet.cloud.blockscout.com` — dead vhost, 404 at every path. This is
  what `chains.ts` still points at, so every "view on explorer" link on the site
  is also broken.
- `explorer.arc.io` — behind Circle's Cloudflare Access, so not public.
- `arc-scan.org` — serves a real app at the root but bot-blocks automated
  requests, so it could not be verified from here. Most likely the right answer;
  worth confirming in a browser.

Whichever it is, update `explorer.url` in `apps/web/src/lib/chains.ts` at the
same time — the same value feeds the site's links and the `links.explorer` field
in the public API.
