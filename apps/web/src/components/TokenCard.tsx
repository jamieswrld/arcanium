import Link from "next/link";
import { TokenAvatar } from "@/components/TokenAvatar";
import { formatPriceE18, formatUsdCompact, GRADUATION_UNITS, type LaunchpadToken } from "@/lib/launchpad";
import { ARC_EXPLORER } from "@/lib/bridgeClient";

/**
 * Launch-grid card: logo, identity, live price/mcap, graduation progress, and
 * the dev (creator) address linking to the explorer. The whole card is a
 * stretched link; the dev link sits above it so both stay clickable without
 * nesting anchors.
 */
export function TokenCard({ token, image }: { readonly token: LaunchpadToken; readonly image?: string | undefined }) {
  const progressPct =
    token.quoteBalance >= GRADUATION_UNITS ? 100 : Number((token.quoteBalance * 100n) / GRADUATION_UNITS);

  return (
    <div className="arch-token-card" style={{ position: "relative" }}>
      <Link
        href={`/tokens/${token.token}`}
        aria-label={`${token.name} (${token.symbol})`}
        style={{ position: "absolute", inset: 0, zIndex: 1, borderRadius: 16 }}
      />

      <div style={{ display: "flex", alignItems: "center", gap: "0.7rem", minWidth: 0 }}>
        <TokenAvatar image={image} symbol={token.symbol} size={44} radius={12} />
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 700, letterSpacing: "-0.01em" }}>{token.symbol}</div>
          <div className="arch-note" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {token.name}
          </div>
        </div>
        {token.graduated ? (
          <span style={{ marginLeft: "auto", fontSize: "0.68rem", fontWeight: 700, color: "var(--positive)", border: "1px solid color-mix(in oklch, var(--positive) 45%, transparent)", borderRadius: 999, padding: "0.15rem 0.5rem", flexShrink: 0 }}>
            GRAD
          </span>
        ) : null}
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: "0.5rem" }}>
        <div>
          <div className="arch-stat-label">Price</div>
          <div style={{ fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>{formatPriceE18(token.priceE18)}</div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div className="arch-stat-label">Market cap</div>
          <div style={{ fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>{formatUsdCompact(token.marketCapUnits)}</div>
        </div>
      </div>

      {!token.graduated ? (
        <div>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
            <span className="arch-note" style={{ fontSize: "0.7rem" }}>Graduation</span>
            <span className="arch-note" style={{ fontSize: "0.7rem", fontVariantNumeric: "tabular-nums" }}>{progressPct}%</span>
          </div>
          <div className="arch-progress" aria-hidden>
            <span style={{ width: `${Math.min(progressPct, 100)}%` }} />
          </div>
        </div>
      ) : (
        <div className="arch-note" style={{ fontSize: "0.7rem" }}>Graduated · liquidity locked forever</div>
      )}

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "0.5rem" }}>
        <span className="arch-note" style={{ fontSize: "0.7rem" }}>Dev</span>
        <a
          href={`${ARC_EXPLORER}/address/${token.creator}`}
          target="_blank"
          rel="noreferrer"
          className="arch-note"
          style={{ position: "relative", zIndex: 2, fontFamily: "monospace", fontSize: "0.72rem", textDecoration: "underline", textUnderlineOffset: 3 }}
        >
          {token.creator.slice(0, 6)}…{token.creator.slice(-4)} ↗
        </a>
      </div>
    </div>
  );
}
