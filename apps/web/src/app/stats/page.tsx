import Link from "next/link";
import { Suspense } from "react";
import { indexedBurned, indexedDaily, indexedProtocolStats, type DailyPoint } from "@/lib/indexed";
import { formatUsdCompact } from "@/lib/launchpad";
import { Sk } from "@/components/Skeletons";

/**
 * Protocol analytics.
 *
 * Everything here comes from the indexer or not at all. The chain path can only
 * reach ~27h of history through Arc's 10k-block getLogs ceiling, so an
 * "all-time" figure derived from it would be a lie — when the indexer cannot
 * answer, this page says so rather than showing a smaller number confidently.
 */

export const dynamic = "force-dynamic";

const RANGES = [7, 14, 30] as const;
type Range = (typeof RANGES)[number];

interface StatsProps {
  readonly searchParams: Promise<{ d?: string }>;
}

export default async function StatsPage({ searchParams }: StatsProps) {
  const sp = await searchParams;
  const parsed = Number.parseInt(sp.d ?? "", 10);
  const range: Range = (RANGES as readonly number[]).includes(parsed) ? (parsed as Range) : 30;

  return (
    <div className="stack">
      <header>
        <h1>Stats</h1>
        <p className="arch-note" style={{ maxWidth: 560 }}>
          Every market launched on Arcanium, and everything traded through them. Volume is
          measured in USDC across all launches.
        </p>
      </header>

      <Suspense fallback={<Sk h={96} />}>
        <Totals />
      </Suspense>

      <section className="panel">
        <div className="spread" style={{ alignItems: "baseline", flexWrap: "wrap", gap: "var(--s3)" }}>
          <div>
            <h2 className="eyebrow">By day</h2>
            <p className="arch-note" style={{ margin: 0 }}>
              Complete UTC days, plus today as a hollow bar that is still filling.
            </p>
          </div>
          <div className="arch-pills" style={{ display: "inline-flex" }}>
            {RANGES.map((d) => (
              <Link
                key={d}
                href={d === 30 ? "/stats" : `/stats?d=${d}`}
                className={d === range ? "arch-pill arch-pill-active" : "arch-pill"}
                aria-current={d === range ? "true" : undefined}
              >
                {d}d
              </Link>
            ))}
          </div>
        </div>

        <Suspense fallback={<Sk h={280} />}>
          <Daily range={range} />
        </Suspense>
      </section>

      <Suspense fallback={<Sk h={120} />}>
        <Burned />
      </Suspense>
    </div>
  );
}

async function Totals() {
  const stats = await indexedProtocolStats();
  if (stats === null) return <Unavailable what="Protocol totals" />;
  return (
    <div className="arch-stat-bar">
      <Stat label="Tokens launched" value={stats.launches.toLocaleString("en-US")} />
      <Stat label="Graduated" value={stats.graduated.toLocaleString("en-US")} />
      <Stat label="Swaps, all time" value={stats.totalTrades.toLocaleString("en-US")} />
      <Stat label="Volume, all time" value={formatUsdCompact(stats.totalVolumeUnits)} />
    </div>
  );
}

async function Daily({ range }: { readonly range: Range }) {
  const points = await indexedDaily(range);
  if (points === null) return <Unavailable what="Daily history" />;
  const trades = points.reduce((a, p) => a + p.swaps, 0);
  if (trades === 0) {
    return (
      <p className="arch-note" style={{ marginTop: "var(--s3)" }}>
        No trades in the last {range} days.
      </p>
    );
  }
  return (
    <div className="stack" style={{ marginTop: "var(--s3)" }}>
      <Bars
        points={points}
        title="Volume"
        caption="Daily trading volume in USDC"
        value={(p) => Number(p.volumeUnits) / 1e6}
        format={(n) => formatUsdCompact(BigInt(Math.round(n * 1e6)))}
      />
      <Bars
        points={points}
        title="Swaps"
        caption="Daily swap count. One trader can make several."
        value={(p) => p.swaps}
        format={(n) => n.toLocaleString("en-US")}
      />
    </div>
  );
}

/**
 * A bar chart as plain elements.
 *
 * No charting library: these are two dozen bars with a label, and a canvas
 * renderer would cost more bytes than the whole page. Heights are percentages
 * so the bars reflow with the container rather than needing a resize observer.
 */
function Bars({
  points,
  title,
  caption,
  value,
  format,
}: {
  readonly points: readonly DailyPoint[];
  readonly title: string;
  readonly caption: string;
  readonly value: (p: DailyPoint) => number;
  readonly format: (n: number) => string;
}) {
  const values = points.map(value);
  // Guard the divisor: an all-zero window would otherwise give every bar a
  // height of NaN% and the chart would vanish silently.
  const peak = Math.max(...values, 0) || 1;
  const total = values.reduce((a, b) => a + b, 0);

  return (
    <figure className="bars-figure">
      <figcaption className="spread" style={{ alignItems: "baseline", gap: "var(--s2)" }}>
        <span className="eyebrow">{title}</span>
        <span className="num" style={{ fontWeight: 650 }}>{format(total)}</span>
      </figcaption>
      <div className="bars" role="img" aria-label={`${title}: ${caption}`}>
        {points.map((p, i) => {
          const v = values[i] ?? 0;
          const day = p.day.toISOString().slice(0, 10);
          return (
            <div
              key={day}
              className={p.complete ? "bar" : "bar bar-partial"}
              // Zero-value days still get a hairline, so a quiet day is visibly
              // a quiet day rather than a gap in the axis.
              style={{ height: `${Math.max((v / peak) * 100, v > 0 ? 2 : 1)}%` }}
              title={`${day} · ${format(v)}${p.complete ? "" : " (today, still filling)"}`}
            />
          );
        })}
      </div>
      <p className="arch-note" style={{ margin: 0 }}>{caption}</p>
    </figure>
  );
}

async function Burned() {
  const burned = await indexedBurned();
  if (burned === null || burned.tokensBurned === 0n) return null;
  const whole = burned.tokensBurned / 10n ** 18n;
  return (
    <section className="panel">
      <h2 className="eyebrow">Burned by Arcane mode</h2>
      <div className="arch-stat-bar" style={{ marginTop: "var(--s2)" }}>
        <Stat label="Tokens burned" value={whole.toLocaleString("en-US")} />
        <Stat label="Value now" value={formatUsdCompact(burned.valueUnits)} />
        <Stat label="Across launches" value={burned.launches.toLocaleString("en-US")} />
      </div>
      <p className="arch-note" style={{ marginTop: "var(--s2)", maxWidth: 620 }}>
        Arcane launches spend their creator fees buying the token back and burning it. Burned
        tokens stay in total supply, so the market caps shown elsewhere are unchanged by this —
        and the value above is what those tokens are worth now, not what the buybacks cost.
      </p>
    </section>
  );
}

function Stat({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div>
      <div className="arch-stat-label">{label}</div>
      <div className="arch-stat-value">{value}</div>
    </div>
  );
}

function Unavailable({ what }: { readonly what: string }) {
  return (
    <p className="arch-note">
      {what} need the indexer, which is not currently caught up. Nothing has been lost — this
      fills in as soon as it catches up.
    </p>
  );
}
