import Link from "next/link";
import { TokenAvatar } from "@/components/TokenAvatar";
import { formatAge, formatPriceE18, formatUsdCompact, type LaunchpadToken } from "@/lib/launchpad";
import { scaleToUsdMicro } from "@/lib/marketStats";
import type { TokenMarket } from "@/lib/marketStats";
import { getChain } from "@/lib/chains";

/**
 * The market currently winning the race to graduation.
 *
 * Deliberately *not* "row one of the table with a bigger typeface". The table
 * beneath already ranks by whatever sort is selected, so repeating its leader
 * here would be decoration rather than information. This answers a different
 * question — which market is closest to actually graduating — which is the one
 * question the table's columns cannot be sorted to answer, because it depends
 * on both how much is in the pool and how fast it is filling.
 *
 * Graduated markets are excluded on purpose: they have already won, so leaving
 * them in would pin the same token here forever and the panel would stop
 * telling anyone anything.
 */

export interface KingOfTheHillProps {
  readonly tokens: readonly LaunchpadToken[];
  readonly market: ReadonlyMap<string, TokenMarket>;
  readonly images: Record<string, string>;
}

/** The contender: most 24h volume among markets still short of graduation. */
export function pickKing(
  tokens: readonly LaunchpadToken[],
  market: ReadonlyMap<string, TokenMarket>,
): LaunchpadToken | null {
  let best: LaunchpadToken | null = null;
  let bestVolume = 0n;
  for (const t of tokens) {
    if (t.graduated) continue;
    const volume = market.get(t.token.toLowerCase())?.volumeUnits ?? 0n;
    // A market with no trades at all is not a contender for anything. Without
    // this every launch with zero volume would tie at 0n and the first one in
    // list order would be crowned.
    if (volume <= 0n) continue;
    if (volume > bestVolume) {
      bestVolume = volume;
      best = t;
    }
  }
  return best;
}

export function KingOfTheHill({ tokens, market, images }: KingOfTheHillProps) {
  const king = pickKing(tokens, market);
  if (king === null) return null;

  const chain = getChain("arc");
  const m = market.get(king.token.toLowerCase());
  const liq = scaleToUsdMicro(king.quoteBalance, chain.quote.decimals);
  const target = chain.graduationUnits;
  const pct = king.quoteBalance >= target ? 100 : Number((king.quoteBalance * 100n) / target);
  const change = m?.changePct ?? null;
  const age = formatAge(king.launchTime);

  return (
    <section className="panel koth" aria-labelledby="koth-heading">
      <div className="koth-head">
        <h2 id="koth-heading" className="eyebrow">
          King of the hill
        </h2>
        <span className="arch-note">Most traded market still short of graduation</span>
      </div>

      <div className="koth-body">
        <Link href={`/tokens/${king.token}`} className="ident koth-ident" title={`${king.name} (${king.symbol})`}>
          <TokenAvatar image={images[king.token.toLowerCase()]} symbol={king.symbol} size={46} radius={10} />
          <span style={{ minWidth: 0 }}>
            <span className="ident-name koth-symbol">{king.symbol}</span>
            <span className="ident-sub" style={{ display: "block" }}>
              {king.name}
              {age === null ? null : <span style={{ color: "var(--text-muted)" }}> · {age}</span>}
            </span>
          </span>
        </Link>

        <dl className="koth-stats">
          <Figure label="Price" value={formatPriceE18(king.priceE18)} />
          <Figure
            label="24H"
            value={change === null ? "—" : `${change >= 0 ? "+" : ""}${change.toFixed(2)}%`}
            tone={change === null ? undefined : change >= 0 ? "pos" : "neg"}
          />
          <Figure label="24H volume" value={m === undefined ? "—" : formatUsdCompact(m.volumeUnits)} />
          <Figure label="Market cap" value={formatUsdCompact(king.marketCapUnits)} />
        </dl>

        <div className="koth-grad">
          <span className="grad-track">
            <span className="grad-fill" style={{ width: `${Math.min(pct, 100)}%` }} />
          </span>
          <span className="num arch-note">
            {pct}% to graduation · {formatUsdCompact(liq)} / 9K
          </span>
        </div>

        <Link href={`/tokens/${king.token}`} className="btn btn-primary koth-cta">
          Trade {king.symbol}
        </Link>
      </div>
    </section>
  );
}

function Figure({
  label,
  value,
  tone,
}: {
  readonly label: string;
  readonly value: string;
  readonly tone?: "pos" | "neg" | undefined;
}) {
  return (
    <div className="koth-figure">
      <dt className="eyebrow">{label}</dt>
      <dd
        className="num"
        style={{
          margin: 0,
          fontWeight: 650,
          color:
            tone === "pos" ? "var(--positive)" : tone === "neg" ? "var(--negative)" : "var(--text-primary)",
        }}
      >
        {value}
      </dd>
    </div>
  );
}
