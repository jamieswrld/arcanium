import { Badge, Card, StatRow } from "@arch/ui";
import type { Hex } from "viem";
import { arcPublicClient, fetchToken, formatPriceE18, GRADUATION_UNITS } from "@/lib/launchpad";
import { formatQuoteUnits } from "@/lib/onchain";
import { ARC_EXPLORER, PAIR_TOKEN_SYMBOL } from "@/lib/bridgeClient";
import { TradePanel } from "@/components/TradePanel";
import { MarketPanels } from "@/components/MarketPanels";
import { TokenAvatar } from "@/components/TokenAvatar";
import { LivePrice } from "@/components/LivePrice";
import { fetchTokenImage } from "@/lib/tokenImages";

export const dynamic = "force-dynamic";

interface TokenPageProps {
  readonly params: Promise<{ address: string }>;
}

/**
 * Token profile — all figures are live chain reads: price/mcap from pool
 * sqrtPriceX96 (exact bigint), graduation progress from the pool's quote
 * balance, plus the wallet-connected trading panel.
 */
export default async function TokenPage({ params }: TokenPageProps) {
  const { address } = await params;
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    return (
      <Card title="Not found">
        <p className="arch-note">That doesn&apos;t look like a token address on Arc.</p>
      </Card>
    );
  }

  const detail = await fetchToken(arcPublicClient(), address as Hex).catch(() => null);
  if (detail === null) {
    return (
      <Card title="Not a launchpad token">
        <p className="arch-note">
          That address isn&apos;t an Arcanium launch on Arc. <a href="/tokens" style={{ textDecoration: "underline" }}>Browse tokens</a>.
        </p>
      </Card>
    );
  }

  const progressPct =
    detail.quoteBalance >= GRADUATION_UNITS
      ? 100
      : Number((detail.quoteBalance * 100n) / GRADUATION_UNITS);
  const image = await fetchTokenImage(detail.token);

  return (
    <div className="arch-stack" style={{ maxWidth: 720, margin: "0 auto" }}>
      <Card>
        <div style={{ display: "flex", gap: "0.75rem", alignItems: "center", flexWrap: "wrap" }}>
          <a href="/tokens" aria-label="Back to tokens" style={{ fontSize: "1.25rem", padding: "0 0.25rem" }}>‹</a>
          <TokenAvatar image={image} symbol={detail.symbol} size={52} radius={14} />
          <div>
            <strong style={{ fontSize: "1.125rem" }}>{detail.name}</strong>{" "}
            <span className="arch-note">{detail.symbol}</span>
            <div className="arch-note" style={{ fontFamily: "monospace", fontSize: "0.75rem" }}>
              {detail.token}
            </div>
          </div>
          <span style={{ marginLeft: "auto", display: "grid", justifyItems: "end", gap: "0.25rem" }}>
            <span className="arch-token-price-big">
              <LivePrice pool={detail.pool} tokenIsToken0={detail.token.toLowerCase() < detail.pairToken.toLowerCase()} initial={formatPriceE18(detail.priceE18)} />
            </span>
            {detail.graduated ? (
              <Badge label="Graduated" tone="positive" />
            ) : (
              <Badge label={`${progressPct}% to graduation`} />
            )}
          </span>
        </div>

        {!detail.graduated ? (
          <div style={{ marginTop: "1rem" }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "0.4rem" }}>
              <span className="arch-note">Graduation progress</span>
              <span className="arch-note" style={{ fontVariantNumeric: "tabular-nums" }}>
                {formatQuoteUnits(detail.quoteBalance)} / 9,000 {PAIR_TOKEN_SYMBOL}
              </span>
            </div>
            <div className="arch-progress" aria-hidden>
              <span style={{ width: `${Math.min(progressPct, 100)}%` }} />
            </div>
          </div>
        ) : null}
      </Card>

      <div className="arch-two-col">
        <Card title="Market">
          <StatRow label="Price" value={formatPriceE18(detail.priceE18)} />
          <StatRow label="Market cap" value={`$${formatQuoteUnits(detail.marketCapUnits)}`} />
          <StatRow label="Pool quote balance" value={`${formatQuoteUnits(detail.quoteBalance)} ${PAIR_TOKEN_SYMBOL}`} />
          <StatRow label="Graduation threshold" value={`9,000 ${PAIR_TOKEN_SYMBOL}`} />
          <StatRow label="Supply" value="1,000,000,000 (fixed)" />
          <StatRow label="Creator" value={`${detail.creator.slice(0, 8)}…`} />
          <p className="arch-note" style={{ marginBottom: 0 }}>
            <a
              href={`${ARC_EXPLORER}/address/${detail.token}`}
              target="_blank"
              rel="noreferrer"
              style={{ textDecoration: "underline" }}
            >
              Token on explorer
            </a>{" "}
            ·{" "}
            <a
              href={`${ARC_EXPLORER}/address/${detail.pool}`}
              target="_blank"
              rel="noreferrer"
              style={{ textDecoration: "underline" }}
            >
              Pool
            </a>{" "}
            · Position #{detail.positionId.toString()}
          </p>
        </Card>

        <Card title="Trade">
          <TradePanel token={detail.token} pairToken={detail.pairToken} symbol={detail.symbol} />
        </Card>
      </div>

      <Card title="Market activity">
        <MarketPanels
          pool={detail.pool}
          token={detail.token}
          pairToken={detail.pairToken}
          symbol={detail.symbol}
        />
      </Card>

      <Card title="Permanent liquidity">
        <p className="arch-note" style={{ margin: 0 }}>
          The full launch supply sits in Uniswap v3 position #{detail.positionId.toString()},
          owned by the Arcanium liquidity vault. It can never be withdrawn or
          transferred — by anyone, including Arcanium. The creator earns a share of
          trading fees for the life of the pool. Graduation at 9,000 {PAIR_TOKEN_SYMBOL} is a
          permanent label only.
        </p>
      </Card>
    </div>
  );
}
