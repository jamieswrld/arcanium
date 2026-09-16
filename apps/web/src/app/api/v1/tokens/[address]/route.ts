import type { NextResponse } from "next/server";
import { arcPublicClient, fetchToken } from "@/lib/launchpad";
import { indexedToken, indexedMarketStats } from "@/lib/indexed";
import { fetchTokenMeta } from "@/lib/tokenImages";
import { getChain } from "@/lib/chains";
import { marketJson } from "@/lib/apiShapes";
import { fail, handle, ok, parseAddress, preflight } from "@/lib/apiV1";
import { withTimeout } from "@/lib/withTimeout";
import type { Hex } from "viem";

/**
 * GET /api/v1/tokens/:address
 *
 * One market in full, including the creator-supplied metadata.
 *
 * Reads the indexer first and falls back to the chain, so a token that launched
 * seconds ago resolves even before it has been indexed. The contracts remain
 * authoritative: anything here can be verified against `pool` and `address`.
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

    const chain = getChain("arc");

    const token =
      (await indexedToken(address).catch(() => null)) ??
      (await withTimeout(fetchToken(arcPublicClient(), address as Hex), null, 8_000, "v1 token"));

    if (token === null) {
      return fail(
        "not_found",
        "No Arcanium market for that address. It was not launched through Arcanium.",
      );
    }

    const [stats, meta] = await Promise.all([
      indexedMarketStats().catch(() => null),
      withTimeout(
        fetchTokenMeta(token.token, chain),
        { image: null, description: null, website: null, twitter: null, telegram: null, discord: null },
        5_000,
        "v1 token meta",
      ),
    ]);

    return ok(
      {
        ...marketJson(token, stats?.[token.token.toLowerCase()]),
        metadata: {
          description: meta.description,
          image: meta.image === null ? null : `https://arcanium.trade/api/token-image/${token.token}`,
          website: meta.website,
          x: meta.twitter,
          telegram: meta.telegram,
          discord: meta.discord,
        },
        supply: { units: (1_000_000_000n * 10n ** 18n).toString(), decimals: 18, fixed: true },
        liquidityLock: {
          // Stated as a fact about the protocol, not a promise from this API.
          permanent: true,
          positionId: token.positionId.toString(),
          note: "The full supply was placed in one Uniswap v3 position at launch and is held permanently. It cannot be withdrawn by anyone, including Arcanium.",
        },
      },
      { chainId: chain.id },
      10,
    );
  });
}
