import type { LaunchpadToken } from "@/lib/launchpad";
import type { IndexedActivity, IndexedMarketStat } from "@/lib/indexed";
import { getChain } from "@/lib/chains";
import { units, usd } from "@/lib/apiV1";

/**
 * Wire shapes for the public API.
 *
 * Kept separate from the route handlers so the contract is defined in exactly
 * one place — the SDK types mirror this file, and a field added here is a field
 * added everywhere rather than in one endpoint by accident.
 *
 * Two rules the shapes enforce:
 *   · No bigints and no floats for money. Every on-chain quantity is a decimal
 *     string in base units with its `decimals` alongside.
 *   · Nulls mean "not known", never "zero". A market with no trades in the
 *     window reports `changePct: null`, because reporting 0 would claim the
 *     price was measured and found unchanged.
 */

export interface MarketJson {
  readonly address: string;
  readonly name: string;
  readonly symbol: string;
  readonly creator: string;
  readonly pool: string;
  readonly chainId: number;
  readonly pair: { readonly address: string; readonly symbol: string; readonly decimals: number };
  readonly price: { readonly units: string; readonly decimals: number };
  readonly marketCap: { readonly units: string; readonly decimals: number };
  readonly liquidity: { readonly units: string; readonly decimals: number };
  readonly volume24h: { readonly units: string; readonly decimals: number } | null;
  readonly change24hPct: number | null;
  readonly trades24h: number | null;
  readonly holders: number | null;
  readonly launchedAt: string | null;
  readonly rewardMode: "standard" | "divium" | "arcane" | null;
  readonly graduated: boolean;
  readonly graduation: {
    readonly target: { readonly units: string; readonly decimals: number };
    readonly progressPct: number;
  };
  readonly links: { readonly explorer: string; readonly app: string };
}

const MODES = ["standard", "divium", "arcane"] as const;

/** Pool balance is in the quote asset's decimals; USD figures are 6dp. */
function toUsdMicro(raw: bigint, decimals: number): bigint {
  if (decimals === 6) return raw;
  if (decimals > 6) return raw / 10n ** BigInt(decimals - 6);
  return raw * 10n ** BigInt(6 - decimals);
}

export function marketJson(t: LaunchpadToken, stat?: IndexedMarketStat | undefined): MarketJson {
  const chain = getChain("arc");
  const target = chain.graduationUnits;
  const progress = t.quoteBalance >= target ? 100 : Number((t.quoteBalance * 100n) / target);
  const trades = stat === undefined ? null : stat.buys + stat.sells;

  return {
    address: t.token,
    name: t.name,
    symbol: t.symbol,
    creator: t.creator,
    pool: t.pool,
    chainId: chain.id,
    pair: {
      address: t.pairToken,
      symbol: chain.quote.symbol,
      decimals: chain.quote.decimals,
    },
    // Price is USD per whole token, scaled 1e18 — the same exact-integer form
    // the protocol math uses, so a client never has to re-derive it from a float.
    price: { units: units(t.priceE18), decimals: 18 },
    marketCap: usd(t.marketCapUnits),
    liquidity: usd(toUsdMicro(t.quoteBalance, chain.quote.decimals)),
    volume24h: stat === undefined ? null : usd(stat.volume24hUnits),
    change24hPct: stat?.changePct ?? null,
    trades24h: trades,
    // Wallets holding a non-zero balance. Null means not counted, which is not
    // the same claim as zero holders.
    holders: t.holderCount,
    // ISO 8601, UTC. Clients derive age themselves rather than trusting a
    // server-rendered "3 days ago" that is wrong the moment it is cached.
    launchedAt: t.launchTime === null ? null : t.launchTime.toISOString(),
    rewardMode: t.mode === null ? null : (MODES[t.mode] ?? null),
    graduated: t.graduated,
    graduation: { target: usd(toUsdMicro(target, chain.quote.decimals)), progressPct: progress },
    links: {
      explorer: `${chain.explorer.url}/token/${t.token}`,
      app: `https://arcanium.trade/tokens/${t.token}`,
    },
  };
}

export interface ActivityJson {
  readonly kind: "buy" | "sell" | "launch";
  readonly token: string;
  readonly symbol: string;
  readonly value: { readonly units: string; readonly decimals: number } | null;
  readonly blockNumber: string;
  readonly timestamp: string;
  readonly txHash: string;
  readonly links: { readonly explorer: string };
}

export function activityJson(e: IndexedActivity): ActivityJson {
  const chain = getChain("arc");
  return {
    kind: e.kind,
    token: e.token,
    symbol: e.symbol === "" ? "" : e.symbol,
    // A launch has no trade value; null says so rather than implying a $0 trade.
    value: e.kind === "launch" ? null : usd(e.valueUnits),
    blockNumber: e.blockNumber.toString(),
    timestamp: e.at.toISOString(),
    txHash: e.txHash,
    links: { explorer: `${chain.explorer.url}/tx/${e.txHash}` },
  };
}
