import type { NextResponse } from "next/server";
import { getChainTokens } from "@/lib/tokensServer";
import { getChain } from "@/lib/chains";
import { fetchPulse } from "@/lib/pulse";
import { indexedPulse } from "@/lib/indexed";
import { activityJson } from "@/lib/apiShapes";
import { handle, ok, parseEnum, parseLimit, preflight } from "@/lib/apiV1";

/**
 * GET /api/v1/activity
 *
 * Protocol-wide activity: trades and launches, newest first.
 *
 *   ?kind=all|buy|sell|launch  (default all)
 *   ?limit=1..200              (default 50)
 *
 * Graduation is not an event here. There is no graduation log on-chain — it is
 * a threshold on the pool's balance — so emitting one would mean inventing a
 * moment it happened. Compare `graduated` on a market instead.
 */
export const dynamic = "force-dynamic";

const KINDS = ["all", "buy", "sell", "launch"] as const;

export function OPTIONS(): NextResponse {
  return preflight();
}

export async function GET(request: Request): Promise<NextResponse> {
  return handle(request, 120, async () => {
    const url = new URL(request.url);
    const kind = parseEnum(url.searchParams.get("kind"), KINDS, "all");
    const limit = parseLimit(url.searchParams.get("limit"), 50, 200);

    const indexed = await indexedPulse(limit).catch(() => null);
    const events =
      indexed ??
      (await (async () => {
        const result = await getChainTokens(getChain("arc"));
        const pulse = await fetchPulse(result.tokens, limit);
        // The chain path ages events from a block delta rather than a stored
        // timestamp, so reconstruct an approximate absolute time for the wire.
        const now = Date.now();
        return pulse.map((p) => ({
          kind: p.kind,
          token: p.token,
          symbol: p.symbol,
          valueUnits: p.valueUnits,
          blockNumber: p.blockNumber,
          at: new Date(now - p.secondsAgo * 1000),
          txHash: p.txHash,
        }));
      })());

    const rows = kind === "all" ? events : events.filter((e) => e.kind === kind);

    return ok(rows.map(activityJson), {
      kind,
      limit,
      count: rows.length,
      chainId: getChain("arc").id,
      source: indexed === null ? "chain" : "indexer",
    }, 5);
  });
}
