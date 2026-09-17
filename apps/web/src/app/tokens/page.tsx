import Link from "next/link";
import { getChainTokens } from "@/lib/tokensServer";
import { getChain } from "@/lib/chains";
import { NetworkStatusNotice } from "@/components/NetworkStatusNotice";
import { fetchTokenImages } from "@/lib/tokenImages";
import { TokenTable } from "@/components/TokenTable";
import { withTimeout } from "@/lib/withTimeout";
import type { LaunchpadToken } from "@/lib/launchpad";

export const dynamic = "force-dynamic";

/**
 * All launches, with search.
 *
 * Explore is the curated front door; this is the full index — every launch
 * across every factory generation, searchable by name, ticker, contract or
 * creator. Tokens are never dropped here because a factory was upgraded.
 */

const SORTS = [
  { key: "newest", label: "Newest" },
  { key: "market_cap", label: "Market cap" },
  { key: "liquidity", label: "Liquidity" },
  { key: "graduated", label: "Graduated" },
] as const;

type SortKey = (typeof SORTS)[number]["key"];

interface TokensPageProps {
  readonly searchParams: Promise<{ sort?: string; q?: string }>;
}

export default async function TokensPage({ searchParams }: TokensPageProps) {
  const { sort: sortParam, q = "" } = await searchParams;
  const sort: SortKey = SORTS.some((s) => s.key === sortParam) ? (sortParam as SortKey) : "newest";

  const arc = getChain("arc");
  const result = await getChainTokens(arc);
  let tokens: LaunchpadToken[] = [...result.tokens];

  const query = q.trim().toLowerCase();
  if (query.length > 0) {
    tokens = tokens.filter(
      (t) =>
        t.name.toLowerCase().includes(query) ||
        t.symbol.toLowerCase().includes(query) ||
        t.token.toLowerCase() === query ||
        t.creator.toLowerCase() === query,
    );
  }

  if (sort === "market_cap") {
    tokens.sort((a, b) => (b.marketCapUnits > a.marketCapUnits ? 1 : b.marketCapUnits < a.marketCapUnits ? -1 : 0));
  } else if (sort === "liquidity") {
    tokens.sort((a, b) => (b.quoteBalance > a.quoteBalance ? 1 : b.quoteBalance < a.quoteBalance ? -1 : 0));
  } else if (sort === "graduated") {
    tokens = tokens.filter((t) => t.graduated);
  }

  const images = await withTimeout(
    fetchTokenImages(tokens.slice(0, 60).map((t) => t.token)),
    {} as Record<string, string>,
    4_000,
    "token logos",
  );

  const href = (next: Partial<{ sort: string; q: string }>): string => {
    const p = new URLSearchParams();
    const s = next.sort ?? sort;
    const qq = next.q ?? q;
    if (s !== "newest") p.set("sort", s);
    if (qq.trim() !== "") p.set("q", qq);
    const str = p.toString();
    return str === "" ? "/tokens" : `/tokens?${str}`;
  };

  return (
    <div className="arch-stack">
      <div>
        <h1>All launches</h1>
        <p className="arch-note" style={{ marginTop: 4 }}>
          Every token launched on Arcanium, across every factory generation. Each one
          trades from block one on permanently locked Uniswap liquidity paired with
          native USDC.
        </p>
      </div>

      <div
        style={{
          display: "flex",
          gap: 12,
          flexWrap: "wrap",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <div className="seg" role="group" aria-label="Sort launches">
          {SORTS.map((s) => (
            <Link key={s.key} href={href({ sort: s.key })} aria-current={s.key === sort ? "true" : undefined}>
              {s.label}
            </Link>
          ))}
        </div>

        <form action="/tokens" method="get" style={{ flex: "1 1 240px", minWidth: 200, maxWidth: 340 }}>
          {sort !== "newest" ? <input type="hidden" name="sort" value={sort} /> : null}
          <div className="arch-form-row" style={{ margin: 0 }}>
            <input
              name="q"
              defaultValue={q}
              aria-label="Search launches"
              placeholder="Search name, ticker, or address…"
              style={{ height: 38 }}
            />
          </div>
        </form>
      </div>

      {result.unreachable && tokens.length === 0 ? (
        <NetworkStatusNotice chains={[arc]} />
      ) : tokens.length === 0 ? (
        <div className="arch-card" style={{ textAlign: "center", padding: "48px 20px" }}>
          <h3 style={{ marginBottom: 6 }}>{query.length > 0 ? "No matches" : "No launches yet"}</h3>
          <p className="arch-note" style={{ maxWidth: 380, margin: "0 auto 18px" }}>
            {query.length > 0
              ? `Nothing matches “${q.trim()}”. Try a ticker, a contract address, or a creator wallet.`
              : "Nothing has launched yet. Be the first."}
          </p>
          <Link href={query.length > 0 ? "/tokens" : "/create"} className="arch-primary-button">
            {query.length > 0 ? "Clear search" : "Launch a token"}
          </Link>
        </div>
      ) : (
        <>
          {result.stale ? (
            <p className="arch-note" style={{ fontSize: "0.8rem" }}>
              Arc is not responding right now — these are the last confirmed figures.
              Every token, position and balance remains secure on-chain.
            </p>
          ) : null}
          <div className="arch-panel">
            <TokenTable tokens={tokens} images={images} chainKey="arc" />
          </div>
        </>
      )}
    </div>
  );
}
