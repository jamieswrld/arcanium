import { NextResponse } from "next/server";
import { arcPublicClient, fetchAllTokens, FACTORY_ADDRESS, LEGACY_FACTORY_ADDRESS } from "@/lib/launchpad";

/**
 * Public launch index for terminals and aggregators: every Arcanium token,
 * newest first. CORS-open, edge-cached. Pair with /api/token-info/{address}
 * for full detail including logo and socials.
 */

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "cache-control": "public, s-maxage=30, stale-while-revalidate=300",
} as const;

export function OPTIONS(): NextResponse {
  return new NextResponse(null, { status: 204, headers: CORS });
}

export async function GET(): Promise<NextResponse> {
  const tokens = await fetchAllTokens(arcPublicClient()).catch(() => []);
  return NextResponse.json(
    {
      chainId: 5042,
      launchpad: "Arcanium",
      factory: FACTORY_ADDRESS ?? null,
      legacyFactory: LEGACY_FACTORY_ADDRESS,
      count: tokens.length,
      tokens: tokens.map((t) => ({
        address: t.token,
        name: t.name,
        symbol: t.symbol,
        pool: t.pool,
        creator: t.creator,
        graduated: t.graduated,
        detail: `https://arcanium.trade/api/token-info/${t.token}`,
      })),
    },
    { headers: CORS },
  );
}
