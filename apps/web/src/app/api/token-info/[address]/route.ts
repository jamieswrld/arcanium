import { NextResponse } from "next/server";
import type { Hex } from "viem";
import { arcPublicClient, fetchToken, formatPriceE18, LEGACY_FACTORY_ADDRESS, FACTORY_ADDRESS } from "@/lib/launchpad";
import { getDb } from "@/lib/db";

/**
 * Public token-info API for terminals and aggregators (gmgn, screeners, bots).
 * CORS-open, cached at the edge. Returns identity, socials, logo, market data,
 * and provenance for any Arcanium launch. Integrators: one GET per token —
 * see /docs/reference/integrators.
 */

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "cache-control": "public, s-maxage=30, stale-while-revalidate=300",
} as const;

function decodeMetadata(uri: string | null | undefined): Record<string, unknown> {
  if (uri === null || uri === undefined || uri === "") return {};
  try {
    const b64 = uri.split(",")[1];
    if (b64 === undefined) return {};
    return JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function OPTIONS(): NextResponse {
  return new NextResponse(null, { status: 204, headers: CORS });
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ address: string }> },
): Promise<NextResponse> {
  const { address } = await context.params;
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    return NextResponse.json({ error: "invalid address" }, { status: 400, headers: CORS });
  }

  const detail = await fetchToken(arcPublicClient(), address as Hex).catch(() => null);
  if (detail === null) {
    return NextResponse.json({ error: "not an Arcanium launch" }, { status: 404, headers: CORS });
  }

  let meta: Record<string, unknown> = {};
  const sql = getDb();
  if (sql !== null) {
    try {
      const rows = await sql<{ metadata_uri: string }[]>`
        SELECT metadata_uri FROM token_metadata WHERE token_address = ${address.toLowerCase()} LIMIT 1
      `;
      meta = decodeMetadata(rows[0]?.metadata_uri);
    } catch { /* metadata store empty — chain data still served */ }
  }

  const str = (k: string): string | null => (typeof meta[k] === "string" && (meta[k] as string) !== "" ? (meta[k] as string) : null);

  return NextResponse.json(
    {
      chainId: 5042,
      address: detail.token,
      name: detail.name,
      symbol: detail.symbol,
      decimals: 18,
      totalSupply: "1000000000",
      image: str("image"),
      description: str("description"),
      links: {
        website: str("website"),
        twitter: str("twitter"),
        telegram: str("telegram"),
      },
      market: {
        pool: detail.pool,
        pairToken: detail.pairToken,
        pairSymbol: "USDC",
        priceUsd: formatPriceE18(detail.priceE18).replace("$", ""),
        marketCapUsd: (Number(detail.marketCapUnits) / 1e6).toFixed(2),
        liquidityUsd: (Number(detail.quoteBalance) / 1e6).toFixed(2),
        graduated: detail.graduated,
      },
      provenance: {
        launchpad: "Arcanium",
        url: `https://arcanium.trade/tokens/${detail.token}`,
        factory: FACTORY_ADDRESS ?? null,
        legacyFactory: LEGACY_FACTORY_ADDRESS,
        creator: detail.creator,
        liquidityLocked: true,
      },
    },
    { headers: CORS },
  );
}
