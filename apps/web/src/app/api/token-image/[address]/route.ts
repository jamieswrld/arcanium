import { NextResponse } from "next/server";
import { fetchTokenMeta } from "@/lib/tokenImages";
import { CHAINS, resolveChain } from "@/lib/chains";

/**
 * A token's logo at a stable https URL.
 *
 * Launch logos are stored as base64 data URIs inside the on-chain metadataUri.
 * That is great for permanence and useless for listings: DexScreener, GMGN,
 * CoinGecko and every other terminal want an https image URL they can fetch and
 * cache. This serves exactly that, decoding the data URI into real image bytes.
 *
 * GET /api/token-image/0xToken
 */
export const dynamic = "force-dynamic";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
} as const;

export function OPTIONS(): NextResponse {
  return new NextResponse(null, { status: 204, headers: CORS });
}

export async function GET(
  request: Request,
  ctx: { params: Promise<{ address: string }> },
): Promise<NextResponse> {
  const { address } = await ctx.params;
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    return NextResponse.json({ error: "bad address" }, { status: 400, headers: CORS });
  }

  const requested = new URL(request.url).searchParams.get("chain");
  const order =
    requested !== null && requested !== ""
      ? [resolveChain(requested), ...CHAINS.filter((c) => c.key !== resolveChain(requested).key)]
      : CHAINS;

  for (const chain of order) {
    if (chain.factories.length === 0) continue;
    const meta = await fetchTokenMeta(address, chain).catch(() => null);
    const img = meta?.image;
    if (img === undefined || img === null) continue;

    // Remote logo: hand the caller the canonical URL rather than proxying it.
    if (img.startsWith("https://")) {
      return NextResponse.redirect(img, { status: 302, headers: CORS });
    }

    const m = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/.exec(img);
    if (m === null) continue;
    const [, mime, b64] = m;
    if (mime === undefined || b64 === undefined) continue;
    const bytes = Buffer.from(b64, "base64");
    if (bytes.length === 0) continue;

    return new NextResponse(new Uint8Array(bytes), {
      status: 200,
      headers: {
        ...CORS,
        "content-type": mime,
        // Launch logos are write-once, so this can be cached hard.
        "cache-control": "public, max-age=86400, s-maxage=604800, immutable",
      },
    });
  }

  return NextResponse.json({ error: "no logo for that token" }, { status: 404, headers: CORS });
}
