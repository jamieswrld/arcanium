import Link from "next/link";
import {
  arcPublicClient,
  arcUnreachable,
  fetchAllTokens,
  GRADUATION_UNITS,
} from "@/lib/launchpad";
import { getTokens } from "@/lib/tokensServer";
import { NetworkStatusNotice } from "@/components/NetworkStatusNotice";
import { fetchTokenImages } from "@/lib/tokenImages";
import { TokenCard } from "@/components/TokenCard";

export const dynamic = "force-dynamic";

interface TokensPageProps {
  readonly searchParams: Promise<{ sort?: string; q?: string }>;
}

/**
 * Launchpad discovery — a live card grid. Every figure is a chain read
 * (price/mcap from pool sqrtPriceX96 via exact bigint math, graduation from
 * the pool's real quote balance). Sort and search are URL params.
 */
export default async function TokensPage({ searchParams }: TokensPageProps) {
  const { sort = "newest", q = "" } = await searchParams;
  const { tokens: fetchedTokens, unreachable } = await getTokens();
  let tokens = fetchedTokens;

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
    tokens = [...tokens].sort((a, b) => (b.marketCapUnits > a.marketCapUnits ? 1 : -1));
  } else if (sort === "graduating") {
    tokens = [...tokens]
      .filter((t) => !t.graduated && t.quoteBalance < GRADUATION_UNITS)
      .sort((a, b) => (b.quoteBalance > a.quoteBalance ? 1 : -1));
  } else if (sort === "graduated") {
    tokens = tokens.filter((t) => t.graduated);
  } else if (sort === "oldest") {
    tokens = [...tokens].reverse();
  }

  const images = await fetchTokenImages(tokens.map((t) => t.token));

  const pills = [
    { key: "newest", label: "Newest" },
    { key: "market_cap", label: "Market cap" },
    { key: "graduating", label: "Near graduation" },
    { key: "graduated", label: "Graduated" },
  ];

  return (
    <div className="arch-stack">
      <div>
        <h1 style={{ margin: 0, fontSize: "1.75rem", fontWeight: 700, letterSpacing: "-0.02em" }}>Launchpad</h1>
        <p className="arch-note" style={{ margin: "0.25rem 0 0" }}>
          Every token trades from block one on permanently locked Uniswap liquidity, paired with native USDC.
        </p>
      </div>

      <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between" }}>
        <div className="arch-pills">
          {pills.map((p) => (
            <Link
              key={p.key}
              href={`/tokens?sort=${p.key}${query ? `&q=${encodeURIComponent(q)}` : ""}`}
              className={p.key === sort ? "arch-pill arch-pill-active" : "arch-pill"}
              style={{ textDecoration: "none" }}
            >
              {p.label}
            </Link>
          ))}
        </div>
        <form action="/tokens" method="get" style={{ flex: "1 1 240px", minWidth: 200, maxWidth: 340 }}>
          <input type="hidden" name="sort" value={sort} />
          <input
            name="q"
            defaultValue={q}
            aria-label="Search tokens"
            placeholder="Search name, ticker, or address…"
            style={{ width: "100%", border: "1px solid var(--border)", borderRadius: 12, padding: "0.6rem 0.9rem", fontSize: "0.9rem", background: "color-mix(in oklch, var(--background) 55%, var(--card))", color: "var(--foreground)" }}
          />
        </form>
      </div>

      {unreachable ? (
        <NetworkStatusNotice />
      ) : tokens.length === 0 ? (
        <section className="arch-card" style={{ textAlign: "center", padding: "3rem 1rem" }}>
          <div style={{ fontSize: "2rem", marginBottom: "0.5rem" }}>◆</div>
          <p className="arch-note" style={{ margin: 0 }}>
            {arcUnreachable
              ? "Can't reach the Arc network right now — this is an RPC outage, not an empty launchpad. Every token and balance is safe on-chain and will reappear as soon as a node responds."
              : query.length > 0
                ? "Nothing matches that search."
                : "No tokens launched yet. Be the first."}
          </p>
          {query.length === 0 && !arcUnreachable ? (
            <Link href="/create" className="arch-pill arch-pill-active" style={{ display: "inline-block", marginTop: "1rem", padding: "0.5rem 1.1rem", textDecoration: "none" }}>
              Launch a token
            </Link>
          ) : null}
        </section>
      ) : (
        <div className="arch-token-grid">
          {tokens.map((t) => (
            <TokenCard key={t.token} token={t} image={images[t.token.toLowerCase()]} />
          ))}
        </div>
      )}

      <p className="arch-note" style={{ textAlign: "center", margin: 0 }}>
        ⓘ A token graduates permanently at 9,000 USDC in its pool — a milestone label only.
        It never unlocks liquidity or changes the market.
      </p>
    </div>
  );
}
