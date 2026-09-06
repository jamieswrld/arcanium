import Link from "next/link";
import { formatUsdCompact, type LaunchpadToken } from "@/lib/launchpad";
import { fetchProtocolStatsMulti } from "@/lib/protocolStats";
import { fetchMarketStats, EMPTY_MARKET, type MarketWindow, type TokenMarket } from "@/lib/marketStats";
import { fetchPulse } from "@/lib/pulse";
import { getChainTokens } from "@/lib/tokensServer";
import { getChain } from "@/lib/chains";
import { NetworkStatusNotice } from "@/components/NetworkStatusNotice";
import { fetchTokenImages } from "@/lib/tokenImages";
import { MarketTable } from "@/components/MarketTable";
import { ArcPulse } from "@/components/ArcPulse";
import { withTimeout } from "@/lib/withTimeout";

/**
 * Explore — the launchpad is the homepage.
 *
 * No full-viewport hero. A compact statement of what this is, the protocol's
 * vital signs, then straight into live markets, because a user who lands here
 * should see tokens launching before they see marketing.
 */
export const dynamic = "force-dynamic";

const SORTS = [
  { key: "trending", label: "Trending" },
  { key: "newest", label: "Newest" },
  { key: "market_cap", label: "Market cap" },
  { key: "volume", label: "Volume" },
  { key: "graduating", label: "Near graduation" },
  { key: "graduated", label: "Graduated" },
] as const;

type SortKey = (typeof SORTS)[number]["key"];

const WINDOWS: readonly { key: MarketWindow; label: string }[] = [
  { key: "1h", label: "1H" },
  { key: "24h", label: "24H" },
];

interface ExploreProps {
  readonly searchParams: Promise<{ sort?: string; w?: string; q?: string }>;
}

export default async function ExplorePage({ searchParams }: ExploreProps) {
  const sp = await searchParams;
  const sort: SortKey = SORTS.some((s) => s.key === sp.sort) ? (sp.sort as SortKey) : "trending";
  const window: MarketWindow = sp.w === "1h" ? "1h" : "24h";
  const q = (sp.q ?? "").trim();

  const arc = getChain("arc");
  const result = await getChainTokens(arc);
  const all: LaunchpadToken[] = [...result.tokens];

  // Market data and the activity feed both walk Swap logs; running them
  // together keeps the page to a single round of RPC work.
  const [market, pulse] = await Promise.all([
    withTimeout(fetchMarketStats(all, window), new Map<string, TokenMarket>(), 9_000, "market stats"),
    withTimeout(fetchPulse(all), [], 7_000, "arc pulse"),
  ]);

  const filtered = filterTokens(all, q);
  const tokens = sortTokens(filtered, sort, market);

  const [images, stats] = await Promise.all([
    withTimeout(
      fetchTokenImages(tokens.slice(0, 40).map((t) => t.token)),
      {} as Record<string, string>,
      4_000,
      "market logos",
    ),
    withTimeout(
      fetchProtocolStatsMulti([{ chain: arc, tokens: result.tokens }]),
      { trades: 0, volAllUnits: 0n, vol24hUnits: 0n, source: "chain" as const },
      6_000,
      "protocol stats",
    ),
  ]);

  const graduated = all.filter((t) => t.graduated).length;
  const outage = all.length === 0 && result.unreachable;

  const href = (next: Partial<{ sort: string; w: string; q: string }>): string => {
    const p = new URLSearchParams();
    const s = next.sort ?? sort;
    const w = next.w ?? window;
    const query = next.q ?? q;
    if (s !== "trending") p.set("sort", s);
    if (w !== "24h") p.set("w", w);
    if (query !== "") p.set("q", query);
    const str = p.toString();
    return str === "" ? "/" : `/?${str}`;
  };

  return (
    <div className="stack">
      {/* Compact header. States the product, offers the two real actions, and
          yields to the market immediately. */}
      <header className="spread" style={{ alignItems: "flex-end", flexWrap: "wrap", gap: "var(--s4)" }}>
        <div style={{ minWidth: 0 }}>
          <h1>Markets begin here.</h1>
          <p className="arch-note" style={{ marginTop: 6, maxWidth: 560 }}>
            Launch and trade permanently locked markets on Arc. Fixed supply, real Uniswap
            liquidity, locked from block one.
          </p>
        </div>
        <div className="row" style={{ flexShrink: 0 }}>
          <Link href="/create" className="btn btn-primary">
            Create token
          </Link>
          <Link href="/docs" className="btn btn-secondary">
            How Arcanium works
          </Link>
        </div>
      </header>

      <div className="arch-stat-bar">
        <div>
          <div className="arch-stat-label">Markets</div>
          <div className="arch-stat-value">{all.length}</div>
        </div>
        <div>
          <div className="arch-stat-label">24h volume</div>
          <div className="arch-stat-value">{formatUsdCompact(stats.vol24hUnits)}</div>
        </div>
        <div>
          <div className="arch-stat-label">
            {stats.source === "indexer" ? "All-time volume" : "Recent volume"}
          </div>
          <div className="arch-stat-value">{formatUsdCompact(stats.volAllUnits)}</div>
        </div>
        <div>
          <div className="arch-stat-label">Trades</div>
          <div className="arch-stat-value">{stats.trades.toLocaleString("en-US")}</div>
        </div>
        <div>
          <div className="arch-stat-label">Graduated</div>
          <div className="arch-stat-value">{graduated}</div>
        </div>
      </div>

      {/* Market controls. Trading switches, not oversized SaaS pills. */}
      <div className="spread" style={{ flexWrap: "wrap", gap: "var(--s3)" }}>
        <div className="rail" style={{ flex: "1 1 320px" }}>
          <div className="seg" role="group" aria-label="Sort markets">
            {SORTS.map((s) => (
              <Link key={s.key} href={href({ sort: s.key })} aria-current={s.key === sort ? "true" : undefined}>
                {s.label}
              </Link>
            ))}
          </div>
          <div className="seg" role="group" aria-label="Time window">
            {WINDOWS.map((w) => (
              <Link key={w.key} href={href({ w: w.key })} aria-current={w.key === window ? "true" : undefined}>
                {w.label}
              </Link>
            ))}
          </div>
        </div>

        <form action="/" method="get" style={{ flex: "0 1 300px", minWidth: 200 }}>
          {sort !== "trending" ? <input type="hidden" name="sort" value={sort} /> : null}
          {window !== "24h" ? <input type="hidden" name="w" value={window} /> : null}
          <input
            className="field"
            name="q"
            defaultValue={q}
            aria-label="Search markets"
            placeholder="Search name, ticker or address"
          />
        </form>
      </div>

      {/* Markets lead; the pulse sits beside them without competing. */}
      <div className="explore-grid">
        <div style={{ minWidth: 0 }}>
          {outage ? (
            <NetworkStatusNotice chains={[arc]} />
          ) : tokens.length === 0 ? (
            <div className="panel">
              <div className="empty">
                <h3>{q !== "" ? "No markets match" : "No markets yet"}</h3>
                <p className="arch-note" style={{ maxWidth: 340 }}>
                  {q !== ""
                    ? `Nothing matches “${q}”. Try a ticker, a contract address, or a creator wallet.`
                    : "Nothing has launched on Arcanium yet. The first market here sets the tone."}
                </p>
                <Link href={q !== "" ? "/" : "/create"} className="btn btn-primary" style={{ marginTop: "var(--s2)" }}>
                  {q !== "" ? "Clear search" : "Create the first token"}
                </Link>
              </div>
            </div>
          ) : (
            <>
              {result.stale ? (
                <p className="arch-note" style={{ marginBottom: "var(--s2)", color: "var(--warning)" }}>
                  Arc is not responding — showing the last confirmed data. Nothing has been lost.
                </p>
              ) : null}
              <div className="panel">
                <MarketTable tokens={tokens} images={images} market={market} window={window} />
              </div>
            </>
          )}
        </div>

        <aside style={{ minWidth: 0 }}>
          <ArcPulse events={pulse} />
        </aside>
      </div>
    </div>
  );
}

function filterTokens(tokens: readonly LaunchpadToken[], q: string): LaunchpadToken[] {
  if (q === "") return [...tokens];
  const needle = q.toLowerCase();
  return tokens.filter(
    (t) =>
      t.name.toLowerCase().includes(needle) ||
      t.symbol.toLowerCase().includes(needle) ||
      t.token.toLowerCase() === needle ||
      t.creator.toLowerCase() === needle,
  );
}

/**
 * Sorting.
 *
 * "Trending" is deliberately defined rather than vibes-based: it ranks by
 * traded volume in the selected window, so it answers "what is actually being
 * bought right now". Markets with no trades fall to the bottom in launch order
 * rather than being hidden — a quiet market is still a market.
 */
function sortTokens(
  tokens: readonly LaunchpadToken[],
  sort: SortKey,
  market: Map<string, TokenMarket>,
): LaunchpadToken[] {
  const list = [...tokens];
  const vol = (t: LaunchpadToken): bigint => (market.get(t.token.toLowerCase()) ?? EMPTY_MARKET).volumeUnits;
  const desc = (a: bigint, b: bigint): number => (b > a ? 1 : b < a ? -1 : 0);

  switch (sort) {
    case "trending":
    case "volume":
      return list.sort((a, b) => desc(vol(a), vol(b)));
    case "market_cap":
      return list.sort((a, b) => desc(a.marketCapUnits, b.marketCapUnits));
    case "graduating":
      return list.filter((t) => !t.graduated).sort((a, b) => desc(a.quoteBalance, b.quoteBalance));
    case "graduated":
      return list.filter((t) => t.graduated);
    default:
      return list;
  }
}
