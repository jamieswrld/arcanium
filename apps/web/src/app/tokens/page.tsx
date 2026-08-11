import Link from "next/link";
import { getTokensForFilter } from "@/lib/tokensServer";
import { CHAINS, resolveChain, type ChainKey } from "@/lib/chains";
import { ChainFilter, type ChainFilterStatus } from "@/components/ChainFilter";
import { NetworkStatusNotice } from "@/components/NetworkStatusNotice";
import { fetchTokenImages } from "@/lib/tokenImages";
import { TokenCard } from "@/components/TokenCard";

export const dynamic = "force-dynamic";

interface TokensPageProps {
  readonly searchParams: Promise<{ sort?: string; q?: string; chain?: string }>;
}

/**
 * Launchpad discovery — a live card grid across every chain. Every figure is a
 * chain read (price/mcap from pool sqrtPriceX96 via exact bigint math,
 * graduation from the pool's real quote balance). Chain, sort and search are
 * all URL params, so any view is linkable and server-rendered.
 */
export default async function TokensPage({ searchParams }: TokensPageProps) {
  const { sort = "newest", q = "", chain: chainParam } = await searchParams;

  const known = new Set<string>(CHAINS.map((c) => c.key));
  const filter: ChainKey | "all" =
    chainParam === undefined || chainParam === "" || chainParam === "all"
      ? "all"
      : known.has(chainParam.toLowerCase())
        ? (chainParam.toLowerCase() as ChainKey)
        : "all";

  const { tokens: fetched, results } = await getTokensForFilter(filter);
  let tokens = fetched;

  const statuses: ChainFilterStatus[] = results.map((r) => ({
    key: r.chain.key,
    unreachable: r.unreachable,
    count: r.tokens.length,
  }));
  // A single-chain view still needs the other tabs to render sensibly.
  const allStatuses: ChainFilterStatus[] =
    filter === "all"
      ? statuses
      : CHAINS.filter((c) => c.factories.length > 0).map(
          (c) => statuses.find((s) => s.key === c.key) ?? { key: c.key, unreachable: false, count: 0 },
        );

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

  const carry: Record<string, string> = {};
  if (query.length > 0) carry["q"] = q;

  /** Only an outage with nothing to show at all warrants the notice. */
  const everythingDown = results.length > 0 && results.every((r) => r.unreachable) && tokens.length === 0;
  const partialOutage = results.filter((r) => r.unreachable);

  return (
    <div className="arch-stack">
      <div>
        <h1 style={{ margin: 0, fontSize: "1.75rem", fontWeight: 700, letterSpacing: "-0.02em" }}>Launchpad</h1>
        <p className="arch-note" style={{ margin: "0.25rem 0 0" }}>
          Every token trades from block one on permanently locked Uniswap liquidity — on Arc, Robinhood and BNB.
        </p>
      </div>

      <ChainFilter active={filter} statuses={allStatuses} params={carry} />

      <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between" }}>
        <div className="arch-pills">
          {pills.map((p) => (
            <Link
              key={p.key}
              href={`/tokens?sort=${p.key}${filter !== "all" ? `&chain=${filter}` : ""}${query ? `&q=${encodeURIComponent(q)}` : ""}`}
              className={p.key === sort ? "arch-pill arch-pill-active" : "arch-pill"}
              style={{ textDecoration: "none" }}
            >
              {p.label}
            </Link>
          ))}
        </div>
        <form action="/tokens" method="get" style={{ flex: "1 1 240px", minWidth: 200, maxWidth: 340 }}>
          <input type="hidden" name="sort" value={sort} />
          {filter !== "all" ? <input type="hidden" name="chain" value={filter} /> : null}
          <input
            name="q"
            defaultValue={q}
            aria-label="Search tokens"
            placeholder="Search name, ticker, or address…"
            style={{ width: "100%", border: "1px solid var(--border)", borderRadius: 12, padding: "0.6rem 0.9rem", fontSize: "0.9rem", background: "color-mix(in oklch, var(--background) 55%, var(--card))", color: "var(--foreground)" }}
          />
        </form>
      </div>

      {everythingDown ? (
        <NetworkStatusNotice />
      ) : (
        <>
          {partialOutage.length > 0 && tokens.length > 0 ? (
            <p className="arch-note" style={{ margin: 0, fontSize: "0.82rem" }}>
              ⓘ {partialOutage.map((r) => r.chain.name).join(" and ")}{" "}
              {partialOutage.length === 1 ? "is" : "are"} unreachable right now — those launches are shown from
              the last confirmed read. Every token, position and balance remains secure on-chain.
            </p>
          ) : null}

          {tokens.length === 0 ? (
            <section className="arch-card" style={{ textAlign: "center", padding: "3rem 1rem" }}>
              <div style={{ fontSize: "2rem", marginBottom: "0.5rem" }}>◆</div>
              <p className="arch-note" style={{ margin: 0 }}>
                {query.length > 0
                  ? "Nothing matches that search."
                  : filter === "all"
                    ? "No tokens launched yet. Be the first."
                    : `No tokens launched on ${resolveChain(filter).name} yet. Be the first.`}
              </p>
              {query.length === 0 ? (
                <Link
                  href={filter === "all" ? "/create" : `/create?chain=${filter}`}
                  className="arch-pill arch-pill-active"
                  style={{ display: "inline-block", marginTop: "1rem", padding: "0.5rem 1.1rem", textDecoration: "none" }}
                >
                  Launch a token
                </Link>
              ) : null}
            </section>
          ) : (
            <div className="arch-token-grid">
              {tokens.map((t) => (
                <TokenCard
                  key={`${t.chainKey}:${t.token}`}
                  token={t}
                  image={images[t.token.toLowerCase()]}
                  chainKey={t.chainKey}
                />
              ))}
            </div>
          )}
        </>
      )}

      <p className="arch-note" style={{ textAlign: "center", margin: 0 }}>
        ⓘ A token graduates permanently at 9,000 of its pair asset — a milestone label only.
        It never unlocks liquidity or changes the market.
      </p>
    </div>
  );
}
