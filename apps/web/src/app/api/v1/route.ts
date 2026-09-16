import type { NextResponse } from "next/server";
import { getChain } from "@/lib/chains";
import { indexerHealth } from "@/lib/indexed";
import { handle, ok, preflight, API_VERSION } from "@/lib/apiV1";

/**
 * GET /api/v1
 *
 * Discovery: what this API is, what it will not do, and where everything lives.
 * Also reports indexer freshness, so an integrator can tell the difference
 * between a quiet market and a lagging index without guessing.
 */

export const dynamic = "force-dynamic";

export function OPTIONS(): NextResponse {
  return preflight();
}

export async function GET(request: Request): Promise<NextResponse> {
  return handle(request, 120, async () => {
    const chain = getChain("arc");
    const health = await indexerHealth().catch(() => null);

    return ok(
      {
        name: "Arcanium API",
        version: API_VERSION,
        chain: {
          id: chain.id,
          name: chain.name,
          quoteAsset: {
            address: chain.quote.address,
            symbol: chain.quote.symbol,
            decimals: chain.quote.decimals,
          },
          explorer: chain.explorer.url,
          factories: chain.factories,
          router: chain.uniswap.swapRouter,
        },
        trustModel: {
          sourceOfTruth: "The Arcanium contracts on Arc.",
          thisApi:
            "Convenience infrastructure: a normalised, cached read over indexed events. It holds no funds, no keys, and never signs.",
          transactions:
            "Transaction endpoints return unsigned calldata for your own wallet to sign. They never accept private keys.",
          verification:
            "Anything security-critical should be verified by reading the contracts directly.",
        },
        endpoints: {
          markets: "/api/v1/markets?sort=trending|new|market_cap|volume|graduating|graduated",
          trending: "/api/v1/markets/trending",
          new: "/api/v1/markets/new",
          token: "/api/v1/tokens/{address}",
          trades: "/api/v1/tokens/{address}/trades",
          holders: "/api/v1/tokens/{address}/holders",
          activity: "/api/v1/activity?kind=all|buy|sell|launch",
          quote: "/api/v1/quote?token={address}&side=buy|sell&amount={baseUnits}",
          buildBuy: "POST /api/v1/transactions/buy",
          buildSell: "POST /api/v1/transactions/sell",
          buildLaunch: "POST /api/v1/transactions/launch",
        },
        conventions: {
          amounts:
            "Every on-chain quantity is a decimal string in base units, with `decimals` alongside. JSON cannot hold a bigint and a float cannot hold a token amount.",
          nulls: "null means not known. It never means zero.",
          errors: '{ "error": { "code", "message" } } — branch on `code`, never on `message`.',
        },
        indexer:
          health === null
            ? { available: false, note: "Falling back to direct chain reads." }
            : {
                available: true,
                caughtUp: health.caughtUp,
                tip: health.tip.toString(),
                blocksBehind: health.behind.toString(),
              },
        docs: "https://arcanium.trade/developers",
      },
      {},
      30,
    );
  });
}
