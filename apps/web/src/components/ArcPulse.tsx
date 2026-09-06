import Link from "next/link";
import type { PulseEvent } from "@/lib/pulse";
import { formatUsdCompact } from "@/lib/launchpad";
import { explorerTx, getChain, type LaunchChain } from "@/lib/chains";

/**
 * ARC PULSE — the live edge of the protocol.
 *
 * Restrained by design: three columns, one accent moment on arrival, then it
 * settles. A trading surface that flashes constantly stops being readable, and
 * this sits beside the market table rather than competing with it.
 *
 * Every row is a real log. When there is nothing, it says so plainly instead of
 * inventing motion.
 */
export function ArcPulse({ events }: { readonly events: readonly PulseEvent[] }) {
  const chain = getChain("arc");

  return (
    <section className="panel" aria-label="Recent protocol activity">
      <div className="panel-head">
        <div className="row">
          <span className="eyebrow" style={{ letterSpacing: "0.12em" }}>
            Arc Pulse
          </span>
          {events.length > 0 ? (
            <span
              aria-hidden
              style={{
                width: 5,
                height: 5,
                borderRadius: 999,
                background: "var(--positive)",
                boxShadow: "0 0 0 3px var(--positive-quiet)",
              }}
            />
          ) : null}
        </div>
        <span className="eyebrow" style={{ letterSpacing: "0.06em" }}>
          Last 4h
        </span>
      </div>

      {events.length === 0 ? (
        <div className="empty" style={{ padding: "32px 20px" }}>
          <p className="arch-note" style={{ maxWidth: 260 }}>
            No trades or launches in the last four hours. Activity appears here the
            moment it lands on-chain.
          </p>
        </div>
      ) : (
        <div className="pulse">
          {events.map((e) => (
            <PulseRow key={`${e.txHash}-${e.blockNumber}-${e.kind}-${e.token}`} event={e} chain={chain} />
          ))}
        </div>
      )}
    </section>
  );
}

function PulseRow({ event, chain }: { readonly event: PulseEvent; readonly chain: LaunchChain }) {
  const tone =
    event.kind === "buy" ? "var(--positive)" : event.kind === "sell" ? "var(--negative)" : "var(--accent)";
  const label = event.kind === "buy" ? "Buy" : event.kind === "sell" ? "Sell" : "Launch";

  return (
    <div className="pulse-row">
      <span className="pulse-kind" style={{ color: tone }}>
        {label}
      </span>

      <span className="row" style={{ minWidth: 0 }}>
        {event.kind === "launch" ? (
          <span className="ident-sub" style={{ color: "var(--text-secondary)" }}>
            new market
          </span>
        ) : (
          <span className="num" style={{ fontWeight: 600 }}>
            {formatUsdCompact(event.valueUnits)}
          </span>
        )}
        <Link
          href={`/tokens/${event.token}`}
          style={{ fontWeight: 650, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
        >
          {event.symbol}
        </Link>
      </span>

      <a
        href={explorerTx(chain, event.txHash)}
        target="_blank"
        rel="noreferrer"
        className="num"
        style={{ color: "var(--text-muted)", fontSize: "0.73rem" }}
        title="View transaction"
      >
        {formatAge(event.secondsAgo)}
      </a>
    </div>
  );
}

/** Compact relative age: 4s, 12m, 3h. */
function formatAge(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h`;
}
