import { NextResponse } from "next/server";
import { getAllChainTokens, getChainTokens } from "@/lib/tokensServer";
import { CHAINS, getChain, resolveChain } from "@/lib/chains";
import { fetchTokenImages } from "@/lib/tokenImages";

/**
 * Public launch index for terminals and aggregators: every Arcanium token on
 * every chain, newest first. CORS-open, edge-cached. Pair with
 * /api/token-info/{address} for full detail including logo and socials.
 *
 * `?chain=arc|robinhood|bnb` narrows to one chain. Top-level `chainId` and
 * `factory` describe Arc so existing consumers keep working; per-token `chain`
 * and `chainId` are authoritative for multi-chain readers.
 */

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "cache-control": "public, s-maxage=30, stale-while-revalidate=300",
} as const;

export function OPTIONS(): NextResponse {
  return new NextResponse(null, { status: 204, headers: CORS });
}

export async function GET(request: Request): Promise<NextResponse> {
  const requested = new URL(request.url).searchParams.get("chain");
  const results =
    requested === null || requested === "" || requested === "all"
      ? await getAllChainTokens().catch(() => [])
      : [await getChainTokens(resolveChain(requested)).catch(() => null)].filter((r) => r !== null);

  const tokens = results.flatMap((r) => r.tokens.map((t) => ({ token: t, chain: r.chain })));
  const images = await fetchTokenImages(tokens.slice(0, 50).map((t) => t.token.token)).catch(
    () => ({}) as Record<string, string>,
  );
  const arc = getChain("arc");

  return NextResponse.json(
    {
      chainId: arc.id,
      launchpad: "Arcanium",
      factory: arc.factories[0] ?? null,
      chains: CHAINS.filter((c) => c.factories.length > 0).map((c) => ({
        key: c.key,
        chainId: c.id,
        name: c.name,
        factory: c.factories[0] ?? null,
        quote: { address: c.quote.address, symbol: c.quote.symbol, decimals: c.quote.decimals },
        explorer: c.explorer.url,
        reachable: !(results.find((r) => r.chain.key === c.key)?.unreachable ?? false),
      })),
      count: tokens.length,
      tokens: tokens.map(({ token: t, chain }) => ({
        address: t.token,
        chain: chain.key,
        chainId: chain.id,
        name: t.name,
        symbol: t.symbol,
        pool: t.pool,
        creator: t.creator,
        pairToken: t.pairToken,
        pairSymbol: chain.quote.symbol,
        graduated: t.graduated,
        marketCapUsd: (Number(t.marketCapUnits) / 1e6).toFixed(0),
        image: images[t.token.toLowerCase()] ?? null,
        detail: `https://arcanium.trade/api/token-info/${t.token}?chain=${chain.key}`,
      })),
    },
    { headers: CORS },
  );
}
