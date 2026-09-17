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

    // Both sources have to be asked before "not found" can be claimed, and
    // the reason each failed has to be kept. A 404 tells an integrator to drop
    // the token from their index permanently; an outage that says 404 makes
    // them do that to a market that exists.
    let reachable = false;
    let token = await indexedToken(address).then(
      (t) => { reachable = true; return t; },
      () => null,
    );
    if (token === null) {
      token = await fetchToken(arcPublicClient(), address as Hex).then(
        (t) => { reachable = true; return t; },
        () => null,
      );
    }

    if (token === null) {
      if (!reachable) {
        return fail(
          "upstream_unavailable",
          "Could not reach the indexer or an Arc RPC, so whether this is an Arcanium market is unknown. This is not a statement that the token does not exist — retry.",
        );
      }
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
          protocol: token.protocol,
          // A v4 market has no position NFT — liquidity sits in the pool and
          // the launchpad contract holds it. Reporting positionId "0" there
          // would send an integrator looking up a position nobody minted, so
          // it is null, and the pool id it does have is given instead.
          positionId: token.protocol === "v4" ? null : token.positionId.toString(),
          poolId: token.poolId,
          note:
            token.protocol === "v4"
              ? "The full supply was placed in one Uniswap v4 pool at launch. The liquidity is held by the Arcanium launchpad contract, which has no function that withdraws it — not for anyone, Arcanium included."
              : "The full supply was placed in one Uniswap v3 position at launch and is held permanently. It cannot be withdrawn by anyone, including Arcanium.",
        },
      },
      { chainId: chain.id },
      10,
    );
  });
}
