import { arcPublicClient, fetchAllTokens } from "@/lib/launchpad";
import { fetchTokenImages } from "@/lib/tokenImages";
import { PortfolioDashboard, type SerializedToken } from "@/components/PortfolioDashboard";

export const metadata = { title: "Portfolio — Arcanium" };
export const revalidate = 15; // token universe cached; wallet data is client-live

/**
 * Portfolio — the wallet dashboard. The server supplies the launch universe
 * (cached list + logos); everything wallet-specific (balances, created tokens,
 * pending + claimed rewards) streams in client-side.
 */
export default async function PortfolioPage() {
  const tokens = await Promise.race([
    fetchAllTokens(arcPublicClient()).catch(() => []),
    new Promise<Awaited<ReturnType<typeof fetchAllTokens>>>((r) => setTimeout(() => r([]), 5000)),
  ]);
  const images = await fetchTokenImages(tokens.map((t) => t.token));

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

  return <PortfolioDashboard tokens={serialized} />;
}
