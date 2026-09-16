import type { NextResponse } from "next/server";
import { tradesFor } from "@/lib/apiQueries";
import { getChain } from "@/lib/chains";
import { fail, handle, ok, parseAddress, parseLimit, parseOffset, preflight } from "@/lib/apiV1";

/**
 * GET /api/v1/tokens/:address/trades
 *
 * Executed swaps against this market, newest first.
 *
 *   ?limit=1..500  (default 100)
 *   ?offset=0..
 *
 * 503 rather than an empty list when the indexer is behind: "no trades" and
 * "we cannot currently tell you" are different answers.
 */
export const dynamic = "force-dynamic";

export function OPTIONS(): NextResponse {
  return preflight();
}

export async function GET(
  request: Request,
  context: { params: Promise<{ address: string }> },
): Promise<NextResponse> {
  return handle(request, 120, async () => {
    const { address: raw } = await context.params;
    const address = parseAddress(raw);
    if (address === null) {
      return fail("invalid_address", "Expected a 0x-prefixed 20-byte address.", { received: raw });
    }

    const url = new URL(request.url);
    const limit = parseLimit(url.searchParams.get("limit"), 100, 500);
    const offset = parseOffset(url.searchParams.get("offset"));

    const rows = await tradesFor(address, limit, offset);
    if (rows === null) {
      return fail("upstream_unavailable", "Trade history is unavailable while the indexer catches up.");
    }

    const chain = getChain("arc");
    return ok(
      rows.map((t) => ({ ...t, links: { explorer: `${chain.explorer.url}/tx/${t.txHash}` } })),
      { token: address, limit, offset, count: rows.length, chainId: chain.id },
      10,
    );
  });
}
