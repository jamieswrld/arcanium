import Link from "next/link";
import { getChainTokens } from "@/lib/tokensServer";
import { getChain, explorerTx } from "@/lib/chains";
import { fetchPulse, type PulseEvent } from "@/lib/pulse";
import { formatUsdCompact } from "@/lib/launchpad";
import { withTimeout } from "@/lib/withTimeout";
import { NetworkStatusNotice } from "@/components/NetworkStatusNotice";

export const dynamic = "force-dynamic";
export const metadata = { title: "Activity — Arcanium" };

/**
 * Activity — the full protocol feed.
 *
 * Explore carries a compact ARC PULSE beside the market table; this is the same
 * indexed events with room to breathe and a filter. Every row is a real log:
 * an empty feed means the chain was quiet, and it says exactly that.
 */

const FILTERS = [
  { key: "all", label: "All" },
  { key: "buy", label: "Buys" },
  { key: "sell", label: "Sells" },
  { key: "launch", label: "Launches" },
] as const;

type FilterKey = (typeof FILTERS)[number]["key"];

interface ActivityProps {
  readonly searchParams: Promise<{ kind?: string }>;
}

export default async function ActivityPage({ searchParams }: ActivityProps) {
  const { kind } = await searchParams;
  const filter: FilterKey = FILTERS.some((f) => f.key === kind) ? (kind as FilterKey) : "all";

  const arc = getChain("arc");
  const result = await getChainTokens(arc);
  // The full feed, not Explore's sidebar slice. The filters below are only
  // useful with enough rows to filter — "Launches" over 24 mixed events is
  // usually two or three.
  const events = await withTimeout(fetchPulse(result.tokens, 150), [] as PulseEvent[], 9_000, "activity feed");
  const rows = filter === "all" ? events : events.filter((e) => e.kind === filter);

  return (
    <div className="stack">
      <header>
        <h1>Activity</h1>
        <p className="arch-note" style={{ marginTop: 6, maxWidth: 560 }}>
          Every trade and launch on Arcanium, read directly from Arc. Roughly the last four
          hours of blocks.
        </p>
      </header>

      <div className="rail">
        <div className="seg" role="group" aria-label="Filter activity">
          {FILTERS.map((f) => (
            <Link
              key={f.key}
              href={f.key === "all" ? "/activity" : `/activity?kind=${f.key}`}
              aria-current={f.key === filter ? "true" : undefined}
            >
              {f.label}
            </Link>
          ))}
        </div>
      </div>

      {result.unreachable && events.length === 0 ? (
        <NetworkStatusNotice chains={[arc]} />
      ) : rows.length === 0 ? (
        <div className="panel">
          <div className="empty">
            <h3>Nothing here yet</h3>
            <p className="arch-note" style={{ maxWidth: 360 }}>
              {events.length === 0
                ? "No trades or launches in the last four hours. This feed fills in as soon as activity lands on-chain."
                : "No events of that type in this window."}
            </p>
            <Link href="/" className="btn btn-secondary" style={{ marginTop: "var(--s2)" }}>
              Browse tokens
            </Link>
          </div>
        </div>
      ) : (
        <div className="panel">
          <div className="pulse">
            {rows.map((e) => (
              <div className="pulse-row" key={`${e.txHash}-${e.blockNumber}-${e.kind}-${e.token}`}>
                <span
                  className="pulse-kind"
                  style={{
                    color:
                      e.kind === "buy"
                        ? "var(--positive)"
                        : e.kind === "sell"
                          ? "var(--negative)"
                          : "var(--accent)",
                  }}
                >
                  {e.kind === "buy" ? "Buy" : e.kind === "sell" ? "Sell" : "Launch"}
                </span>

                <span className="row" style={{ minWidth: 0 }}>
                  {e.kind === "launch" ? (
                    <span className="ident-sub" style={{ color: "var(--text-secondary)" }}>
                      new market
                    </span>
                  ) : (
                    <span className="num" style={{ fontWeight: 600 }}>
                      {formatUsdCompact(e.valueUnits)}
                    </span>
                  )}
                  <Link href={`/tokens/${e.token}`} style={{ fontWeight: 650 }}>
                    {e.symbol}
                  </Link>
                </span>

                <a
                  href={explorerTx(arc, e.txHash)}
                  target="_blank"
                  rel="noreferrer"
                  className="num"
                  style={{ color: "var(--text-muted)", fontSize: "0.73rem" }}
                  title="View transaction"
                >
                  {e.secondsAgo < 60
                    ? `${e.secondsAgo}s`
                    : e.secondsAgo < 3600
                      ? `${Math.floor(e.secondsAgo / 60)}m`
                      : `${Math.floor(e.secondsAgo / 3600)}h`}
                </a>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
