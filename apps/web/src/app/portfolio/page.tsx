import { getChainTokens } from "@/lib/tokensServer";
import { resolveChain, CHAINS } from "@/lib/chains";
import { ChainFilter, type ChainFilterStatus } from "@/components/ChainFilter";
import { fetchTokenImages } from "@/lib/tokenImages";
import { withTimeout } from "@/lib/withTimeout";
import { PortfolioDashboard, type SerializedToken } from "@/components/PortfolioDashboard";

export const metadata = { title: "Portfolio - Arcanium" };
export const revalidate = 15; // token universe cached; wallet data is client-live

interface PortfolioPageProps {
  readonly searchParams: Promise<{ chain?: string }>;
}

/**
 * Portfolio - the wallet dashboard, one chain at a time. The server supplies
 * that chain's launch universe (cached list + logos); everything
 * wallet-specific (balances, created tokens, pending + claimed rewards) streams
 * in client-side against the same chain.
 */
export default async function PortfolioPage({ searchParams }: PortfolioPageProps) {
  const { chain: chainParam } = await searchParams;
  const chain = resolveChain(chainParam);
  const result = await getChainTokens(chain);
  const tokens = result.tokens;

  const images = await withTimeout(
    fetchTokenImages(tokens.map((t) => t.token)),
    {} as Record<string, string>,
    4_000,
    "token logos",
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

  const statuses: ChainFilterStatus[] = CHAINS.filter((c) => c.factories.length > 0).map((c) =>
    c.key === chain.key
      ? { key: c.key, unreachable: result.unreachable, count: tokens.length }
      : { key: c.key, unreachable: false, count: 0 },
  );

  return (
    <div className="arch-stack">
      <ChainFilter active={chain.key} statuses={statuses} basePath="/portfolio" />
      <PortfolioDashboard tokens={serialized} chainKey={chain.key} />
    </div>
  );
}
