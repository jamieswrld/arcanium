import { NextResponse } from "next/server";
import { indexedTokens } from "@/lib/indexed";
import { getChain } from "@/lib/chains";

/**
 * Every Arcanium token as a standard token list.
 *
 * A logo that only this site can render is not much of a logo. Launch images
 * are base64 data URIs inside a metadata blob in our database, which no
 * outside indexer can read — /api/token-image turns one into real bytes at a
 * stable https URL, and this is what tells anybody those URLs exist. It is the
 * Uniswap token-list schema, which wallets, routers, explorers and terminals
 * already know how to consume, so integrating means fetching one file rather
 * than asking us for anything.
 *
 * It is not a route to the big terminals on its own. GeckoTerminal — which is
 * upstream of a good deal of that world — has Arc registered as a network but
 * has not indexed a single DEX on it, and a terminal that has never seen the
 * pool has nowhere to hang a picture. That needs Uniswap on Arc to be indexed,
 * which is a request to them and not something published here can force. This
 * is the half that does not need anyone's permission.
 *
 * GET /tokenlist.json
 */

export const revalidate = 300;

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
} as const;

export function OPTIONS(): NextResponse {
  return new NextResponse(null, { status: 204, headers: CORS });
}

const SITE = "https://arcanium.trade";

export async function GET(): Promise<NextResponse> {
  const chain = getChain("arc");
  const tokens = await indexedTokens().catch(() => null);

  if (tokens === null) {
    // A token list is a claim about what exists. Serving an empty one while
    // the indexer is unreachable would tell every consumer that Arcanium has
    // no tokens, and the ones that cache aggressively would go on saying it
    // after we recovered. 503 says "ask again", which is true.
    return NextResponse.json(
      { error: "token index unavailable" },
      { status: 503, headers: { ...CORS, "cache-control": "no-store" } },
    );
  }

  return NextResponse.json(
    {
      name: "Arcanium",
      // The schema requires the version to increase whenever the list changes,
      // and the only thing that changes it is a launch. Counting them gives a
      // number that rises exactly when it should, without a timestamp making
      // every response look like a new version.
      version: { major: 1, minor: tokens.length, patch: 0 },
      logoURI: `${SITE}/icon.png`,
      keywords: ["arcanium", "arc", "launchpad", "uniswap"],
      tokens: tokens.map((t) => ({
        chainId: chain.id,
        address: t.token,
        name: t.name,
        symbol: t.symbol,
        decimals: 18,
        logoURI: `${SITE}/api/token-image/${t.token.toLowerCase()}`,
      })),
    },
    { headers: { ...CORS, "cache-control": "public, max-age=300, s-maxage=300" } },
  );
}
