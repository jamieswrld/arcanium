import type { NextResponse } from "next/server";
import { getChainTokens } from "@/lib/tokensServer";
import { getChain } from "@/lib/chains";
import { fetchMarketStats } from "@/lib/marketStats";
import { marketJson } from "@/lib/apiShapes";
import { fail, handle, ok, parseEnum, parseLimit, parseOffset, preflight } from "@/lib/apiV1";
import type { LaunchpadToken } from "@/lib/launchpad";

/**
 * GET /api/v1/markets
 *
 * Every Arcanium market on Arc.
 *
 *   ?sort=trending|new|market_cap|volume|graduating|graduated   (default trending)
 *   ?limit=1..200                                               (default 50)
 *   ?offset=0..
 *   ?q=substring of name, ticker, contract or creator
 *
 * "trending" ranks by traded volume over the last 24h — a definition, not a
 * mood. Markets with no trades sort last in launch order rather than being
 * hidden; a quiet market is still a market.
 */

export const dynamic = "force-dynamic";

const SORTS = ["trending", "new", "market_cap", "volume", "graduating", "graduated"] as const;
type Sort = (typeof SORTS)[number];

export function OPTIONS(): NextResponse {
  return preflight();
}

export async function GET(request: Request): Promise<NextResponse> {
  return handle(request, 120, async () => {
    const url = new URL(request.url);
    const sort = parseEnum<Sort>(url.searchParams.get("sort"), SORTS, "trending");
    const limit = parseLimit(url.searchParams.get("limit"), 50, 200);
    const offset = parseOffset(url.searchParams.get("offset"));
    const q = (url.searchParams.get("q") ?? "").trim().toLowerCase();

    const arc = getChain("arc");
    const result = await getChainTokens(arc);

    if (result.tokens.length === 0 && result.unreachable) {
      return fail(
        "upstream_unavailable",
        "Arc is not reachable right now and no cached snapshot is available.",
      );
    }

    // The same source the website uses, which is the point: this endpoint used
    // to read the indexer directly with no fallback, so an indexer outage made
    // every volume, change and trade count null here while the site itself
    // carried on from chain. Two ways of computing the same truth, disagreeing
    // exactly when it mattered.
    const market = await fetchMarketStats(result.tokens, "24h").catch(
      () => new Map<string, { volumeUnits: bigint; trades: number; changePct: number | null }>(),
    );
    const stats: Record<string, { volume24hUnits: bigint; changePct: number | null; buys: number; sells: number }> =
      {};
    for (const [key, m] of market) {
      // fetchMarketStats reports a combined trade count rather than a buy/sell
      // split; the wire shape only ever sums them again.
      stats[key] = { volume24hUnits: m.volumeUnits, changePct: m.changePct, buys: m.trades, sells: 0 };
    }
    // Honest staleness: any token with no stat at all means the window could
    // not be read, not that nothing traded.
    const statsKnown = market.size > 0;

    let list: LaunchpadToken[] = [...result.tokens];
    if (q !== "") {
      list = list.filter(
        (t) =>
          t.name.toLowerCase().includes(q) ||
          t.symbol.toLowerCase().includes(q) ||
          t.token.toLowerCase() === q ||
          t.creator.toLowerCase() === q,
      );
    }

    const volumeOf = (t: LaunchpadToken): bigint =>
      stats[t.token.toLowerCase()]?.volume24hUnits ?? 0n;
    const desc = (a: bigint, b: bigint): number => (b > a ? 1 : b < a ? -1 : 0);

    switch (sort) {
      case "trending":
      case "volume":
        list.sort((a, b) => desc(volumeOf(a), volumeOf(b)));
        break;
      case "market_cap":
        list.sort((a, b) => desc(a.marketCapUnits, b.marketCapUnits));
        break;
      case "graduating":
        list = list.filter((t) => !t.graduated).sort((a, b) => desc(a.quoteBalance, b.quoteBalance));
        break;
      case "graduated":
        list = list.filter((t) => t.graduated);
        break;
      case "new":
      default:
        break; // already newest-first from the reader
    }

    const total = list.length;
    const page = list.slice(offset, offset + limit);

    return ok(
      page.map((t) => marketJson(t, stats[t.token.toLowerCase()])),
      {
        total,
        limit,
        offset,
        sort,
        chainId: arc.id,
        // Honest about provenance. `stale` used to mean only "Arc was
        // unreachable", so it reported false while every volume, change and
        // trade count came back null because the market window could not be
        // read. A consumer cannot tell a quiet market from an unreadable one
        // unless this says which it is.
        stale: result.stale || !statsKnown,
      },
      15,
    );
  });
}
