# Launching against more than one quote asset

Scoping note. No code has been written for this.

**Proposed quote assets:** Arc's native token, Arc USDC, and Arcanium's own token.

## Summary

The contracts already support this. `ArchLaunchpadFactoryV4` keeps an
`allowedPairTokens` allowlist and rejects anything not on it:

```solidity
mapping(address => bool) public allowedPairTokens;
...
if (!allowedPairTokens[params.pairToken]) revert PairTokenNotAllowed();
```

and exposes `setPairTokenAllowed(address token, bool allowed) external onlyOwner`.
We hold that owner key (`0x8fA45d6cA2D97fcfa7496C4D34647EC3CBB48764`). Enabling a
second quote asset on-chain is therefore **one transaction**, not a deployment.

That is also the trap. Turning it on is trivial; everything downstream of it
assumes the quote asset is worth exactly one dollar, and none of that assumption
is enforced anywhere. Enabling a non-USD quote without the work below would not
fail loudly — it would quietly relabel a price denominated in ARCT as dollars.

**Recommendation: worth doing, but not as a config change.** Budget the pricing
work first, ship one non-USD asset, and only then add the third.

## The actual blocker: "USD" is an assumption, not a conversion

`priceUsdE18` turns a pool price into a "USD" price by adjusting for token
decimals and nothing else:

```ts
// apps/web/src/lib/launchpad.ts
export function priceUsdE18(sqrtPriceX96, tokenIsToken0, quoteDecimals = 6) {
  const scale = 10n ** BigInt(36 - quoteDecimals);
  ...
}
```

With USDC as the quote this is correct and exact — one unit really is one dollar.
With any other asset the same function returns a number denominated in that
asset, still labelled USD. `apps/indexer/src/price.ts` has the same shape and
hardcodes a 6-decimal quote.

Everything derived from it inherits the error:

| Surface | What breaks |
|---|---|
| Token price, market cap | Denominated in the quote asset, labelled USD |
| 24h volume, all-time volume | `volume_usd_e6` sums quote amounts across assets that are not the same unit |
| 24h change | Correct as a ratio; wrong the moment it is compared across pairs |
| Graduation progress | 9,000 "units" of a quote that is not a dollar is not a $9,000 milestone |
| Position P&L | Cost basis and value are in different units the moment a wallet trades both |
| Sorting and ranking | Market cap and volume sorts compare unlike quantities |
| `token_stats`, `candles` | Stored in the same columns, so past rows become unreadable retroactively |

The last row is the one to be careful about: these are stored figures, not
computed ones. Once mixed-unit rows are written, existing history cannot be
distinguished from new history without a migration.

## Work required

**1. A price source for each non-USD quote asset.** Nothing in the stack has
one today. For Arcanium's own token this is circular — its price comes from its
own pool, which would have to be priced in USDC. Workable, but it means the
USDC pool becomes the pricing oracle for every ARCT-quoted launch, and a thin
pool there prices everything else on the site.

**2. Carry the quote asset through the pricing path.** `priceUsdE18` grows a
quote-price argument; the indexer stores both the raw quote amount *and* the USD
conversion, with the rate used. Schema change to `swaps`, `token_stats` and
`candles`.

**3. Per-asset graduation thresholds.** `graduationUnits` is currently
`9_000 * 10^decimals`. It has to become a USD target converted at the current
rate, or an explicit per-asset figure. This is a launch-economics decision, not
an implementation detail.

**4. UI.** Pair filter on the explore page, quote selector on the launch form,
and — the part that is easy to forget — every figure needs to state its unit,
because "$3,041" and "3,041 ARCT" can no longer share a column.

**5. Backfill / migration.** Existing rows need marking as USDC-quoted before
any mixed-unit row is written.

Rough shape: the contract change is minutes, the pricing and schema work is the
bulk of it, and the UI is straightforward once units are carried properly.

## One thing to resolve first

Two of the three proposed assets may be the same thing.

On Arc the native gas token **is** USDC — `nativeCurrency` is declared as USDC
with 18 decimals, and `0x3600000000000000000000000000000000000000` is a
6-decimal ERC-20 view of that same asset. So "Arc's native token" and "Arc USDC"
are plausibly one asset in two representations, in which case this is a
two-asset change (USDC + ARCT), not three.

If a distinct ARC token is meant, we need its address before any of the above
can be scoped properly — the pricing work depends entirely on what it is and
where it trades.

## If the goal is listings rather than choice

Worth naming, because it may be the cheaper path to the same end. If the reason
for multi-quote is that aggregators ignore Arcanium markets, note that gmgn
returns "No Available Router" for our tokens because it does not have Arc's
Uniswap fork addresses, not because of the quote asset. Submitting the factory,
position manager and SwapRouter02 addresses to those platforms costs nothing and
addresses that problem directly.
