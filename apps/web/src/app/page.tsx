import Link from "next/link";
import { formatUsdCompact, type LaunchpadToken } from "@/lib/launchpad";
import { fetchProtocolStatsMulti } from "@/lib/protocolStats";
import { getAllChainTokens } from "@/lib/tokensServer";
import { NetworkStatusNotice } from "@/components/NetworkStatusNotice";
import { fetchTokenImages } from "@/lib/tokenImages";
import { TokenTable } from "@/components/TokenTable";
import { withTimeout } from "@/lib/withTimeout";

/**
 * Explore — the launchpad itself.
 *
 * The product is the launches, so they start above the fold. The hero states
 * what this is in one line and gets out of the way; the stat strip gives the
 * pad's vital signs; everything below is live inventory the user can sort.
 */
export const dynamic = "force-dynamic";

const SORTS = [
  { key: "newest", label: "Newest" },
  { key: "market_cap", label: "Market cap" },
  { key: "liquidity", label: "Liquidity" },
  { key: "graduating", label: "Near graduation" },
] as const;

type SortKey = (typeof SORTS)[number]["key"];

interface HomeProps {
  readonly searchParams: Promise<{ sort?: string }>;
}

export default async function ExplorePage({ searchParams }: HomeProps) {
  const { sort: sortParam } = await searchParams;
  const sort: SortKey = SORTS.some((s) => s.key === sortParam) ? (sortParam as SortKey) : "newest";

  const results = await getAllChainTokens();
  const all = results.flatMap((r) => [...r.tokens]);
  const down = results.filter((r) => r.unreachable);
  // Never claim an empty pad while a network is unreachable — an outage is not
  // an absence of tokens.
  const unreachable = all.length === 0 && down.length > 0;

  const tokens = sortTokens(all, sort);

  const [images, stats] = await Promise.all([
    withTimeout(
      fetchTokenImages(tokens.slice(0, 40).map((t) => t.token)),
      {} as Record<string, string>,
      4_000,
      "explore logos",
    ),
    withTimeout(
      fetchProtocolStatsMulti(results.map((r) => ({ chain: r.chain, tokens: r.tokens }))),
      { trades: 0, volAllUnits: 0n, vol24hUnits: 0n, source: "chain" as const },
      6_000,
      "protocol stats",
    ),
  ]);

  const graduated = all.filter((t) => t.graduated).length;

  return (
    <div className="arch-stack">
      <section className="arch-hero">
        <div className="arch-hero-logo" aria-hidden>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/arcanium-mark.png" alt="" width={64} height={50} />
        </div>
        <h1>
          Launch a token on Arc.
          <br />
          <span className="arch-gradient-text">Locked liquidity from block one.</span>
        </h1>
        <p className="arch-note" style={{ fontSize: "0.95rem", maxWidth: 520, marginTop: 10 }}>
          Every launch pairs with native USDC on real Uniswap v3 liquidity that is
          permanently locked. No bonding curve, no pre-market, no launch fee.
        </p>
        <div style={{ display: "flex", gap: 10, marginTop: 20, flexWrap: "wrap", justifyContent: "center" }}>
          <Link href="/create" className="arch-primary-button">
            Launch a token
          </Link>
          <Link href="/docs" className="arch-button-secondary">
            How it works
          </Link>
        </div>
      </section>

      <div className="arch-stat-bar">
        <div>
          <div className="arch-stat-label">Tokens launched</div>
          <div className="arch-stat-value">{all.length}</div>
        </div>
        <div>
          <div className="arch-stat-label">24h volume</div>
          <div className="arch-stat-value">{formatUsdCompact(stats.vol24hUnits)}</div>
        </div>
        <div>
          {/* Only the indexer sees true all-time history; the chain walk is
              capped at what getLogs will return, so the label says so. */}
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

      <section>
        <div className="arch-token-list-head">
          <h2>Launches</h2>
          <div className="arch-segment" role="group" aria-label="Sort launches">
            {SORTS.map((s) => (
              <Link
                key={s.key}
                href={s.key === "newest" ? "/" : `/?sort=${s.key}`}
                aria-current={s.key === sort ? "true" : undefined}
              >
                {s.label}
              </Link>
            ))}
          </div>
        </div>

        {unreachable ? (
          <NetworkStatusNotice chains={down.map((r) => r.chain)} />
        ) : tokens.length === 0 ? (
          <div className="arch-card" style={{ textAlign: "center", padding: "56px 20px" }}>
            <h3 style={{ marginBottom: 6 }}>No launches yet</h3>
            <p className="arch-note" style={{ maxWidth: 380, margin: "0 auto 18px" }}>
              Nothing has launched on Arcanium yet. The first token here sets the tone
              for the pad.
            </p>
            <Link href="/create" className="arch-primary-button">
              Launch the first token
            </Link>
          </div>
        ) : (
          <div className="arch-panel">
            <TokenTable tokens={tokens} images={images} chainKey="arc" />
          </div>
        )}
      </section>

      <p className="arch-note" style={{ textAlign: "center", fontSize: "0.78rem" }}>
        A token graduates permanently at 9,000 USDC in its pool — a milestone label only.
        It never unlocks liquidity or changes the market.
      </p>
    </div>
  );
}

/** Sorting is deliberate about ties: newest is the on-chain order reversed, and
 *  the value sorts fall back to that so the list never reshuffles arbitrarily. */
function sortTokens(tokens: readonly LaunchpadToken[], sort: SortKey): LaunchpadToken[] {
  const list = [...tokens];
  switch (sort) {
    case "market_cap":
      return list.sort((a, b) => (b.marketCapUnits > a.marketCapUnits ? 1 : b.marketCapUnits < a.marketCapUnits ? -1 : 0));
    case "liquidity":
      return list.sort((a, b) => (b.quoteBalance > a.quoteBalance ? 1 : b.quoteBalance < a.quoteBalance ? -1 : 0));
    case "graduating":
      return list
        .filter((t) => !t.graduated)
        .sort((a, b) => (b.quoteBalance > a.quoteBalance ? 1 : b.quoteBalance < a.quoteBalance ? -1 : 0));
    default:
      return list;
  }
}
