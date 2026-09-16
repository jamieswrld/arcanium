import type { NextResponse } from "next/server";
import { holdersFor } from "@/lib/apiQueries";
import { getChain } from "@/lib/chains";
import { fail, handle, ok, parseAddress, parseLimit, parseOffset, preflight } from "@/lib/apiV1";

/**
 * GET /api/v1/tokens/:address/holders
 *
 * Current holders by balance, largest first.
 *
 * The launch pool itself appears here and is usually the largest holder by a
 * wide margin — that is the locked liquidity, not a whale. Callers presenting a
 * distribution should exclude the market's `pool` address.
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

    const rows = await holdersFor(address, limit, offset);
    if (rows === null) {
      return fail("upstream_unavailable", "Holder data is unavailable while the indexer catches up.");
    }

    return ok(rows, {
      token: address,
      limit,
      offset,
      count: rows.length,
      chainId: getChain("arc").id,
      note: "Includes the launch pool, which holds the permanently locked liquidity.",
    }, 30);
  });
}
