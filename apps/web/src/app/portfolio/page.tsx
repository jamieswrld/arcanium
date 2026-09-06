import { getChainTokens } from "@/lib/tokensServer";
import { getChain } from "@/lib/chains";
import { fetchTokenImages } from "@/lib/tokenImages";
import { withTimeout } from "@/lib/withTimeout";
import { PortfolioDashboard, type SerializedToken } from "@/components/PortfolioDashboard";

export const metadata = { title: "Portfolio — Arcanium" };
export const dynamic = "force-dynamic";

/**
 * Portfolio — the wallet dashboard.
 *
 * The server supplies the launch universe (list + logos); everything
 * wallet-specific — balances, tokens you created, pending and claimed creator
 * rewards — streams in client-side against Arc.
 */
export default async function PortfolioPage() {
  const arc = getChain("arc");
  const result = await getChainTokens(arc);
  const tokens = result.tokens;

  const images = await withTimeout(
    fetchTokenImages(tokens.map((t) => t.token)),
    {} as Record<string, string>,
    4_000,
    "portfolio logos",
  );

  const serialized: SerializedToken[] = tokens.map((t) => ({
    token: t.token,
    name: t.name,
    symbol: t.symbol,
    creator: t.creator,
    pairToken: t.pairToken,
    pool: t.pool,
    positionId: t.positionId.toString(),
    priceE18: t.priceE18.toString(),
    graduated: t.graduated,
    image: images[t.token.toLowerCase()] ?? null,
  }));

  return <PortfolioDashboard tokens={serialized} chainKey="arc" />;
}
