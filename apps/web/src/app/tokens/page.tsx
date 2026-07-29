import Link from "next/link";
import { Badge, Card } from "@arch/ui";
import {
  arcPublicClient,
  fetchAllTokens,
  formatPriceE18,
  GRADUATION_UNITS,
} from "@/lib/launchpad";
import { formatQuoteUnits } from "@/lib/onchain";

export const revalidate = 30;

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
  let tokens = await fetchAllTokens(arcPublicClient()).catch(() => []);

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

  const pills = [
    { key: "newest", label: "Newest" },
    { key: "market_cap", label: "Market cap" },
    { key: "graduating", label: "Near graduation" },
    { key: "graduated", label: "Graduated" },
  ];

  return (
    <div className="arch-stack">
      <div className="arch-section-head">
        <h1 style={{ margin: 0, fontSize: "1.5rem" }}>Tokens</h1>
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
      </div>

      <form action="/tokens" method="get" className="arch-form-row" style={{ marginBottom: 0 }}>
        <input type="hidden" name="sort" value={sort} />
        <input
          name="q"
          defaultValue={q}
          aria-label="Search tokens"
          placeholder="Search name, ticker, token address, or creator"
        />
      </form>

      <Card>
        <div className="arch-token-list-head">
          <span>Token</span>
          <span>Price</span>
          <span>Market cap</span>
        </div>
        {tokens.length === 0 ? (
          <p className="arch-note" style={{ margin: "1rem 0 0" }}>
            {query.length > 0
              ? "Nothing matches that search."
              : "No tokens launched yet. Be the first — every launch trades instantly through permanently locked Uniswap liquidity."}
          </p>
        ) : (
          <div style={{ display: "grid", gap: "0.25rem", marginTop: "0.5rem" }}>
            {tokens.map((t) => {
              const progressPct =
                t.quoteBalance >= GRADUATION_UNITS
                  ? 100
                  : Number((t.quoteBalance * 100n) / GRADUATION_UNITS);
              return (
                <Link
                  key={t.token}
                  href={`/tokens/${t.token}`}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1fr 120px 120px",
                    gap: "0.75rem",
                    padding: "0.6rem 0",
                    borderBottom: "1px solid var(--arch-border)",
                    alignItems: "center",
                  }}
                >
                  <span>
                    <strong>{t.symbol}</strong>{" "}
                    <span className="arch-note">
                      {t.name}
                      {t.graduated ? " · graduated" : ` · ${progressPct}% to graduation`}
                    </span>
                  </span>
                  <span>{formatPriceE18(t.priceE18)}</span>
                  <span>${formatQuoteUnits(t.marketCapUnits)}</span>
                </Link>
              );
            })}
          </div>
        )}
      </Card>

      <Card title="Graduation">
        <p className="arch-note" style={{ margin: 0 }}>
          <Badge label="ⓘ" /> A token graduates permanently when its pool holds
          9,000 aUSD or USDC. Graduation is a milestone label only: it never
          unlocks liquidity, never changes the token, and never moves the
          market.
        </p>
      </Card>
    </div>
  );
}
