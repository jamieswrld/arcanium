import Link from "next/link";
import { TokenAvatar } from "@/components/TokenAvatar";
import { formatPriceE18, formatUsdCompact, type LaunchpadToken } from "@/lib/launchpad";
import { getChain, type ChainKey } from "@/lib/chains";
import { ArcaneWandIcon, DiviumBillsIcon } from "@/components/ModeIcons";

/**
 * The launch list.
 *
 * Launches are inventory, and inventory is read by comparison — is this one
 * bigger, closer to graduating, cheaper than the one above it. A table answers
 * that in one downward glance; a grid of cards makes the eye re-anchor on every
 * tile. Numbers are right-aligned and tabular so the columns actually line up,
 * which is the entire point of showing them together.
 *
 * Identity carries the row: logo, name, ticker. Everything else is a supporting
 * column, and the whole row is one link target.
 */

export interface TokenTableProps {
  readonly tokens: readonly LaunchpadToken[];
  readonly images: Record<string, string>;
  readonly chainKey?: ChainKey;
  /** Rank numbers reflect the active sort, so they renumber as it changes. */
  readonly showRank?: boolean;
}

export function TokenTable({ tokens, images, chainKey = "arc", showRank = true }: TokenTableProps) {
  const chain = getChain(chainKey);

  return (
    <div className="arch-scroll-x">
      <table className="arch-table">
        <thead>
          <tr>
            <th scope="col">{showRank ? "# Token" : "Token"}</th>
            <th scope="col">Price</th>
            <th scope="col">Market cap</th>
            <th scope="col">Liquidity</th>
            <th scope="col">Graduation</th>
            <th scope="col">Mode</th>
          </tr>
        </thead>
        <tbody>
          {tokens.map((t, i) => {
            const target = chain.graduationUnits;
            const pct = t.quoteBalance >= target ? 100 : Number((t.quoteBalance * 100n) / target);
            return (
              <tr key={t.token}>
                <td>
                  <Link href={`/tokens/${t.token}`} className="arch-ident" title={`${t.name} (${t.symbol})`}>
                    {showRank ? (
                      <span
                        className="arch-num"
                        style={{ color: "var(--text-faint)", width: 18, textAlign: "right", flexShrink: 0 }}
                      >
                        {i + 1}
                      </span>
                    ) : null}
                    <TokenAvatar image={images[t.token.toLowerCase()]} symbol={t.symbol} size={32} radius={9} />
                    <span style={{ minWidth: 0 }}>
                      <span className="arch-ident-name">{t.symbol}</span>
                      <span className="arch-ident-sub" style={{ display: "block" }}>
                        {t.name}
                      </span>
                    </span>
                  </Link>
                </td>

                <td className="arch-num">{formatPriceE18(t.priceE18)}</td>
                <td className="arch-num-lg">{formatUsdCompact(t.marketCapUnits)}</td>

                {/* Real quote sitting in the pool — the number that says whether
                    a token can actually absorb a trade. */}
                <td className="arch-num" style={{ color: "var(--text-muted)" }}>
                  {formatUsdCompact(scaleToUsdMicro(t.quoteBalance, chain.quote.decimals))}
                </td>

                <td style={{ minWidth: 128 }}>
                  {t.graduated ? (
                    <span style={{ color: "var(--positive)", fontWeight: 650, fontSize: "0.78rem" }}>Graduated</span>
                  ) : (
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 8, width: "100%" }}>
                      <span className="arch-progress" style={{ flex: 1, minWidth: 56 }}>
                        <span style={{ width: `${Math.min(pct, 100)}%` }} />
                      </span>
                      <span className="arch-num" style={{ color: "var(--text-faint)", fontSize: "0.78rem", width: 34 }}>
                        {pct}%
                      </span>
                    </span>
                  )}
                </td>

                <td>
                  {t.mode === 1 || t.mode === 2 ? (
                    <span
                      className="arch-network-pill"
                      title={
                        t.mode === 1
                          ? "Divium — creator fees are paid out to holders"
                          : "Arcane — creator fees buy the token and burn it"
                      }
                    >
                      {t.mode === 1 ? <DiviumBillsIcon size={12} /> : <ArcaneWandIcon size={12} />}
                      {t.mode === 1 ? "Divium" : "Arcane"}
                    </span>
                  ) : (
                    <span style={{ color: "var(--text-faint)" }}>—</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Pool balance to the 6-decimal USD micro-units formatUsdCompact expects. */
function scaleToUsdMicro(raw: bigint, decimals: number): bigint {
  if (decimals === 6) return raw;
  if (decimals > 6) return raw / 10n ** BigInt(decimals - 6);
  return raw * 10n ** BigInt(6 - decimals);
}
