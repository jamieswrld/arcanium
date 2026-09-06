import { Suspense } from "react";
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
import { Sk } from "@/components/Skeletons";
import { withTimeout } from "@/lib/withTimeout";

/**
 * Explore — the launchpad is the homepage.
 *
 * Streamed deliberately. The shell, the header and the market controls are
 * static and ship immediately; the three data regions each suspend on their own.
 * Before this, one server render awaited every chain read before sending a byte,
 * so a cold load showed a full-page skeleton for ~7s even though the header and
 * controls needed nothing at all.
 *
 * The regions share the same cached Swap window, so streaming costs no extra
 * chain work — it only stops the slowest read from gating the fastest paint.
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

      <Suspense fallback={<StatStripSkeleton />}>
        <StatStrip />
      </Suspense>

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

      <div className="explore-grid">
        <div style={{ minWidth: 0 }}>
          <Suspense fallback={<TableSkeleton />}>
            <Markets sort={sort} window={window} q={q} />
          </Suspense>
        </div>
        <aside style={{ minWidth: 0 }}>
          <Suspense fallback={<PulseSkeleton />}>
            <PulseRegion />
          </Suspense>
        </aside>
      </div>

      <p className="arch-note" style={{ textAlign: "center", fontSize: "0.78rem" }}>
        A token graduates permanently at 9,000 USDC in its pool — a milestone label only. It never
        unlocks liquidity or changes the market.
      </p>
    </div>
  );
}

/* ------------------------------------------------------------- data regions */

async function StatStrip() {
  const arc = getChain("arc");
  const result = await getChainTokens(arc);
  const stats = await withTimeout(
    fetchProtocolStatsMulti([{ chain: arc, tokens: result.tokens }]),
    { trades: 0, volAllUnits: 0n, vol24hUnits: 0n, source: "chain" as const },
    12_000,
    "protocol stats",
  );
  const graduated = result.tokens.filter((t) => t.graduated).length;

  return (
    <div className="arch-stat-bar">
      <Stat label="Markets" value={String(result.tokens.length)} />
      <Stat label="24h volume" value={formatUsdCompact(stats.vol24hUnits)} />
      <Stat
        // Only the indexer sees true all-time history; the chain walk is bounded
        // by what getLogs will return, so the label says which one this is.
        label={stats.source === "indexer" ? "All-time volume" : "Recent volume"}
        value={formatUsdCompact(stats.volAllUnits)}
      />
      <Stat label="Trades" value={stats.trades.toLocaleString("en-US")} />
      <Stat label="Graduated" value={String(graduated)} />
    </div>
  );
}

async function Markets({
  sort,
  window,
  q,
}: {
  readonly sort: SortKey;
  readonly window: MarketWindow;
  readonly q: string;
}) {
  const arc = getChain("arc");
  const result = await getChainTokens(arc);
  const all: LaunchpadToken[] = [...result.tokens];

  const market = await withTimeout(
    fetchMarketStats(all, window),
    new Map<string, TokenMarket>(),
    12_000,
    "market stats",
  );

  const tokens = sortTokens(filterTokens(all, q), sort, market);
  const images = await withTimeout(
    fetchTokenImages(tokens.slice(0, 40).map((t) => t.token)),
    {} as Record<string, string>,
    4_000,
    "market logos",
  );

  if (all.length === 0 && result.unreachable) return <NetworkStatusNotice chains={[arc]} />;

  if (tokens.length === 0) {
    return (
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
    );
  }

  return (
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
  );
}

async function PulseRegion() {
  const arc = getChain("arc");
  const result = await getChainTokens(arc);
  const events = await withTimeout(fetchPulse(result.tokens), [], 12_000, "arc pulse");
  return <ArcPulse events={events} />;
}

/* ------------------------------------------------------------------ pieces */

function Stat({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div>
      <div className="arch-stat-label">{label}</div>
      <div className="arch-stat-value">{value}</div>
    </div>
  );
}

function StatStripSkeleton() {
  return (
    <div className="arch-stat-bar" aria-hidden>
      {Array.from({ length: 5 }, (_, i) => (
        <div key={i}>
          <Sk h={9} w={62} />
          <Sk h={18} w={74} style={{ marginTop: 7 }} />
        </div>
      ))}
    </div>
  );
}

function TableSkeleton() {
  return (
    <div className="panel" aria-hidden>
      <div style={{ padding: "var(--s3) var(--s4)", borderBottom: "1px solid var(--border)" }}>
        <Sk h={9} w={120} />
      </div>
      {Array.from({ length: 8 }, (_, i) => (
        <div
          key={i}
          className="spread"
          style={{ padding: "11px var(--s4)", borderBottom: "1px solid var(--border)", gap: "var(--s3)" }}
        >
          <div className="row" style={{ minWidth: 0 }}>
            <Sk h={30} w={30} r={7} />
            <div>
              <Sk h={11} w={62} />
              <Sk h={9} w={96} style={{ marginTop: 5 }} />
            </div>
          </div>
          <Sk h={11} w={70} />
        </div>
      ))}
    </div>
  );
}

function PulseSkeleton() {
  return (
    <div className="panel" aria-hidden>
      <div style={{ padding: "var(--s3) var(--s4)", borderBottom: "1px solid var(--border)" }}>
        <Sk h={9} w={70} />
      </div>
      {Array.from({ length: 6 }, (_, i) => (
        <div
          key={i}
          className="spread"
          style={{ padding: "8px var(--s4)", borderBottom: "1px solid var(--border)", gap: "var(--s2)" }}
        >
          <Sk h={9} w={34} />
          <Sk h={9} w={78} />
          <Sk h={9} w={22} />
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------- logic */

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
 * "Trending" is defined rather than vibes-based: volume traded in the selected
 * window. Markets with no trades fall to the bottom in launch order rather than
 * being hidden — a quiet market is still a market.
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
