import Link from "next/link";
import { TokenAvatar } from "@/components/TokenAvatar";
import { formatPriceE18, formatUsdCompact, type LaunchpadToken } from "@/lib/launchpad";
import { explorerAddress, getChain, type ChainKey } from "@/lib/chains";
import { ChainBadge } from "@/components/ChainMark";
import { ArcaneWandIcon, DiviumBillsIcon } from "@/components/ModeIcons";

/**
 * Launch-grid card: logo, identity, live price/mcap, graduation progress, and
 * the dev (creator) address linking to the explorer. The whole card is a
 * stretched link; the dev link sits above it so both stay clickable without
 * nesting anchors.
 */
export function TokenCard({
  token,
  image,
  chainKey = "arc",
}: {
  readonly token: LaunchpadToken;
  readonly image?: string | undefined;
  readonly chainKey?: ChainKey;
}) {
  // Graduation is 9,000 of the pair asset, whose decimals differ per chain.
  const chain = getChain(chainKey);
  const target = chain.graduationUnits;
  const progressPct =
    token.quoteBalance >= target ? 100 : Number((token.quoteBalance * 100n) / target);

  return (
    <div className="arch-token-card" style={{ position: "relative" }}>
      <Link
        href={chainKey === "arc" ? `/tokens/${token.token}` : `/tokens/${token.token}?chain=${chainKey}`}
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
        {token.mode === 1 || token.mode === 2 ? (
          <span
            title={token.mode === 1 ? "Divium — creator fees paid to holders" : "Arcane Mode — creator fees buy and burn"}
            style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 4, flexShrink: 0, border: "1px solid var(--border)", borderRadius: 999, padding: "0.15rem 0.45rem", background: "var(--muted)" }}
          >
            {token.mode === 1 ? <DiviumBillsIcon size={14} /> : <ArcaneWandIcon size={14} />}
            <span style={{ fontSize: "0.6rem", fontWeight: 700, letterSpacing: "0.04em" }}>
              {token.mode === 1 ? "DIVIUM" : "ARCANE"}
            </span>
          </span>
        ) : null}
        {token.graduated ? (
          <span style={{ marginLeft: token.mode === 1 || token.mode === 2 ? "0.35rem" : "auto", fontSize: "0.68rem", fontWeight: 700, color: "var(--positive)", border: "1px solid color-mix(in oklch, var(--positive) 45%, transparent)", borderRadius: 999, padding: "0.15rem 0.5rem", flexShrink: 0 }}>
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
        <span style={{ display: "inline-flex", alignItems: "center", gap: "0.4rem" }}>
          <ChainBadge chain={chain} />
          <span className="arch-note" style={{ fontSize: "0.7rem" }}>Dev</span>
        </span>
        <a
          href={explorerAddress(chain, token.creator)}
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
