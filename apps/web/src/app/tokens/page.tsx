import Link from "next/link";
import { Badge, Card } from "@arch/ui";
import {
  arcPublicClient,
  fetchAllTokens,
  formatPriceE18,
  GRADUATION_UNITS,
} from "@/lib/launchpad";
import { formatQuoteUnits } from "@/lib/onchain";
import { fetchTokenImages } from "@/lib/tokenImages";
import { TokenAvatar } from "@/components/TokenAvatar";

export const dynamic = "force-dynamic";

interface TokensPageProps {
  readonly searchParams: Promise<{ sort?: string; q?: string }>;
}

/**
 * Launchpad discovery — every row is a live chain read (price and market cap
 * from pool sqrtPriceX96 via exact bigint math, graduation progress from the
 * pool's real quote balance). Sort and search are URL params so views can be
 * shared.
 */
export default async function TokensPage({ searchParams }: TokensPageProps) {
  const { sort = "newest", q = "" } = await searchParams;
  let tokens = await Promise.race([
    fetchAllTokens(arcPublicClient()).catch(() => []),
    new Promise<Awaited<ReturnType<typeof fetchAllTokens>>>((r) => setTimeout(() => r([]), 8000)),
  ]);

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
      .filter((t) => !t.graduated)
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
          Every token trades from block one through permanently locked liquidity.
        </p>
      </div>

      <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between" }}>
        <div className="arch-pills">
          {pills.map((p) => (
            <Link
              key={p.key}
              href={`/tokens?sort=${p.key}${query ? `&q=${encodeURIComponent(q)}` : ""}`}
              className={p.key === sort ? "arch-pill arch-pill-active" : "arch-pill"}
            >
              {p.label}
            </Link>
          ))}
        </div>
        <form action="/tokens" method="get" style={{ flex: "1 1 240px", minWidth: 200 }}>
          <input type="hidden" name="sort" value={sort} />
          <input
            name="q"
            defaultValue={q}
            aria-label="Search tokens"
            placeholder="Search name, ticker, or address…"
            style={{ width: "100%", border: "1px solid var(--border)", borderRadius: 12, padding: "0.6rem 0.9rem", fontSize: "0.9rem", background: "var(--card)" }}
          />
        </form>
      </div>

      <Card>
        <div className="arch-token-list-head" style={{ gridTemplateColumns: "1fr 120px 130px" }}>
          <span>Token</span>
          <span style={{ textAlign: "right" }}>Price</span>
          <span style={{ textAlign: "right" }}>Market cap</span>
        </div>
        {tokens.length === 0 ? (
          <div style={{ textAlign: "center", padding: "3rem 1rem" }}>
            <div style={{ fontSize: "2rem", marginBottom: "0.5rem" }}>◆</div>
            <p className="arch-note" style={{ margin: 0 }}>
              {query.length > 0
                ? "Nothing matches that search."
                : "No tokens launched yet. Be the first."}
            </p>
            {query.length === 0 ? (
              <Link href="/create" className="arch-pill arch-pill-active" style={{ display: "inline-block", marginTop: "1rem", padding: "0.5rem 1.1rem" }}>
                Launch a token
              </Link>
            ) : null}
          </div>
        ) : (
          <div style={{ display: "grid", marginTop: "0.35rem" }}>
            {tokens.map((t) => {
              const progressPct =
                t.quoteBalance >= GRADUATION_UNITS
                  ? 100
                  : Number((t.quoteBalance * 100n) / GRADUATION_UNITS);
              return (
                <Link
                  key={t.token}
                  href={`/tokens/${t.token}`}
                  className="arch-token-row"
                >
                  <span style={{ display: "flex", alignItems: "center", gap: "0.7rem", minWidth: 0 }}>
                    <TokenAvatar image={images[t.token.toLowerCase()]} symbol={t.symbol} />
                    <span style={{ minWidth: 0, flex: 1 }}>
                      <span style={{ display: "block", fontWeight: 600 }}>{t.symbol}</span>
                      <span className="arch-note" style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {t.name}{t.graduated ? " · graduated" : ""}
                      </span>
                      {!t.graduated ? (
                        <span className="arch-progress" style={{ display: "block", marginTop: 4, maxWidth: 180 }}>
                          <span style={{ width: `${Math.min(progressPct, 100)}%` }} />
                        </span>
                      ) : null}
                    </span>
                  </span>
                  <span style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", fontWeight: 500 }}>{formatPriceE18(t.priceE18)}</span>
                  <span style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", fontWeight: 500 }}>${formatQuoteUnits(t.marketCapUnits)}</span>
                </Link>
              );
            })}
          </div>
        )}
      </Card>

      <p className="arch-note" style={{ textAlign: "center", margin: 0 }}>
        <Badge label="ⓘ" /> A token graduates permanently at 9,000 USDC in its pool — a
        milestone label only. It never unlocks liquidity or changes the market.
      </p>
    </div>
  );
}
