import Link from "next/link";
import { TokenAvatar } from "@/components/TokenAvatar";
import { formatAge, formatPriceE18, formatUsdCompact, type LaunchpadToken } from "@/lib/launchpad";
import { getChain } from "@/lib/chains";
import { EMPTY_MARKET, scaleToUsdMicro, type MarketWindow, type TokenMarket } from "@/lib/marketStats";
import { ArcaneWandIcon, DiviumBillsIcon } from "@/components/ModeIcons";

/**
 * The market list.
 *
 * Launches are inventory and inventory is read by comparison — is this one
 * bigger, moving harder, closer to graduating than the row above. A table
 * answers that in one downward glance, with numbers right-aligned and tabular
 * so the digits actually line up rather than merely sitting near each other.
 *
 * On narrow screens the same data becomes a stacked market object (see the
 * `.mkt-stack` rules): identity and price lead, secondary metrics form a small
 * grid beneath. That is a different layout for a different device, not a
 * horizontally-scrolled desktop table.
 *
 * Columns show only what we can prove. 24h change and volume come from real
 * Swap logs; a token with no trades in the window shows a dash rather than a
 * fabricated 0.00%.
 */

export interface MarketTableProps {
  readonly tokens: readonly LaunchpadToken[];
  readonly images: Record<string, string>;
  readonly market: Map<string, TokenMarket>;
  /** Labels the change and volume columns with the window they measure. */
  readonly window: MarketWindow;
}

export function MarketTable({ tokens, images, market, window }: MarketTableProps) {
  const chain = getChain("arc");
  const wl = window === "1h" ? "1H" : "24H";

  return (
    <div className="mkt-wrap">
      <table className="mkt">
        <thead>
          <tr>
            <th scope="col">Token</th>
            <th scope="col">Price</th>
            <th scope="col">{wl}</th>
            <th scope="col">Market cap</th>
            <th scope="col">{wl} volume</th>
            <th scope="col">Liquidity</th>
            <th scope="col">Holders</th>
            <th scope="col">Graduation</th>
          </tr>
        </thead>
        <tbody>
          {tokens.map((t, i) => {
            const m = market.get(t.token.toLowerCase()) ?? EMPTY_MARKET;
            const target = chain.graduationUnits;
            const pct = t.quoteBalance >= target ? 100 : Number((t.quoteBalance * 100n) / target);
            const liq = scaleToUsdMicro(t.quoteBalance, chain.quote.decimals);
            const age = formatAge(t.launchTime);

            return (
              <tr key={t.token}>
                <td data-label="Token">
                  <Link href={`/tokens/${t.token}`} className="ident" title={`${t.name} (${t.symbol})`}>
                    <span className="num mkt-rank" aria-hidden>
                      {i + 1}
                    </span>
                    <TokenAvatar image={images[t.token.toLowerCase()]} symbol={t.symbol} size={30} radius={7} />
                    <span style={{ minWidth: 0 }}>
                      <span className="ident-name">{t.symbol}</span>
                      <span className="ident-sub" style={{ display: "block" }}>
                        {t.name}
                        {age === null ? null : <span style={{ color: "var(--text-muted)" }}> · {age}</span>}
                      </span>
                    </span>
                    {t.mode === 1 || t.mode === 2 ? (
                      <span
                        className="chip"
                        title={
                          t.mode === 1
                            ? "Divium — creator fees are paid out to holders"
                            : "Arcane — creator fees buy the token and burn it"
                        }
                      >
                        {t.mode === 1 ? <DiviumBillsIcon size={11} /> : <ArcaneWandIcon size={11} />}
                        {t.mode === 1 ? "Divium" : "Arcane"}
                      </span>
                    ) : null}
                  </Link>
                </td>

                <td data-label="Price" className="num">
                  {formatPriceE18(t.priceE18)}
                </td>

                <td data-label={wl}>
                  <Change pct={m.changePct} />
                </td>

                <td data-label="Market cap" className="num" style={{ fontWeight: 650 }}>
                  {formatUsdCompact(t.marketCapUnits)}
                </td>

                <td data-label={`${wl} volume`} className="num" style={{ color: "var(--text-secondary)" }}>
                  {m.trades === 0 ? <Dash /> : formatUsdCompact(m.volumeUnits)}
                </td>

                <td data-label="Liquidity" className="num" style={{ color: "var(--text-secondary)" }}>
                  {formatUsdCompact(liq)}
                </td>

                <td data-label="Holders" className="num" style={{ color: "var(--text-secondary)" }}>
                  {t.holderCount === null ? <Dash /> : t.holderCount.toLocaleString("en-US")}
                </td>

                <td data-label="Graduation">
                  {t.graduated ? (
                    <span className="chip chip-pos">Graduated</span>
                  ) : (
                    <span className="grad">
                      <span className="grad-track">
                        <span className="grad-fill" style={{ width: `${Math.min(pct, 100)}%` }} />
                      </span>
                      <span className="num" style={{ color: "var(--text-muted)", fontSize: "0.7rem" }}>
                        {pct}% · {formatUsdCompact(liq)} / 9K
                      </span>
                    </span>
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

function Change({ pct }: { readonly pct: number | null }) {
  if (pct === null) return <Dash />;
  const up = pct >= 0;
  return (
    <span className="num" style={{ color: up ? "var(--positive)" : "var(--negative)", fontWeight: 600 }}>
      {up ? "+" : ""}
      {pct.toFixed(2)}%
    </span>
  );
}

/** No trades in the window. Saying so beats inventing a zero. */
function Dash() {
  return (
    <span style={{ color: "var(--text-muted)" }} title="No trades in this window">
      —
    </span>
  );
}

