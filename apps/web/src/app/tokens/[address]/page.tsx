import { Badge, Card, StatRow } from "@arch/ui";
import type { Hex } from "viem";
import { formatUnits } from "viem";
import { arcPublicClient, fetchToken, formatPriceE18, isHidden } from "@/lib/launchpad";
import { fetchTokenOn } from "@/lib/launchpadChain";
import { CHAINS, explorerAddress, getChain, resolveChain, type LaunchChain } from "@/lib/chains";
import { ChainBadge } from "@/components/ChainMark";
import { TradePanel } from "@/components/TradePanel";
import { MarketPanels } from "@/components/MarketPanels";
import { TokenAvatar } from "@/components/TokenAvatar";
import { LivePrice } from "@/components/LivePrice";
import { CopyButton } from "@/components/CopyButton";
import { CreatorFees } from "@/components/CreatorFees";
import { TokenMode } from "@/components/TokenMode";
import { fetchTokenImage } from "@/lib/tokenImages";

export const revalidate = 10; // edge-cached shell; 2s client polling keeps the terminal live

interface TokenPageProps {
  readonly params: Promise<{ address: string }>;
  readonly searchParams: Promise<{ chain?: string }>;
}

/** Find a launch by address. Tries the requested chain first, then every other
 *  configured chain, so a bare /tokens/0x… link resolves wherever it lives. */
async function findToken(
  address: `0x${string}`,
  preferred: LaunchChain,
): Promise<{ detail: Awaited<ReturnType<typeof fetchToken>>; chain: LaunchChain } | null> {
  const read = async (c: LaunchChain) =>
    c.key === "arc"
      ? await fetchToken(arcPublicClient(), address).catch(() => null)
      : await fetchTokenOn(c, address).catch(() => null);

  const first = await read(preferred);
  if (first !== null) return { detail: first, chain: preferred };

  const others = CHAINS.filter((c) => c.key !== preferred.key && c.factories.length > 0);
  const found = await Promise.all(others.map(async (c) => ({ detail: await read(c), chain: c })));
  const hit = found.find((f) => f.detail !== null);
  return hit === undefined ? null : { detail: hit.detail, chain: hit.chain };
}

/**
 * Token profile — all figures are live chain reads: price/mcap from pool
 * sqrtPriceX96 (exact bigint), graduation progress from the pool's quote
 * balance, plus the wallet-connected trading panel.
 */
export default async function TokenPage({ params, searchParams }: TokenPageProps) {
  const { address } = await params;
  const { chain: chainParam } = await searchParams;
  if (!/^0x[0-9a-fA-F]{40}$/.test(address) || isHidden(address)) {
    return (
      <Card title="Not found">
        <p className="arch-note">That token isn&apos;t listed on Arcanium.</p>
      </Card>
    );
  }

  const found = await findToken(address as Hex, resolveChain(chainParam));
  const detail = found?.detail ?? null;
  const chain = found?.chain ?? getChain("arc");
  const quoteSymbol = chain.quote.symbol;
  const formatQuoteUnits = (v: bigint): string => formatUnits(v, chain.quote.decimals);
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
    detail.quoteBalance >= chain.graduationUnits
      ? 100
      : Number((detail.quoteBalance * 100n) / chain.graduationUnits);
  const image = await fetchTokenImage(detail.token);

  return (
    <div className="arch-stack" style={{ maxWidth: 1100, margin: "0 auto" }}>
      <Card>
        <div style={{ display: "flex", gap: "0.75rem", alignItems: "center", flexWrap: "wrap" }}>
          <a href="/tokens" aria-label="Back to tokens" style={{ fontSize: "1.25rem", padding: "0 0.25rem" }}>‹</a>
          <TokenAvatar image={image} symbol={detail.symbol} size={52} radius={14} />
          <div>
            <strong style={{ fontSize: "1.125rem" }}>{detail.name}</strong>{" "}
            <span className="arch-note">{detail.symbol}</span>
            <div className="arch-note" style={{ fontFamily: "monospace", fontSize: "0.75rem", display: "flex", alignItems: "center", flexWrap: "wrap", gap: "0.15rem" }}>
              <span>{detail.token.slice(0, 10)}…{detail.token.slice(-8)}</span>
              <CopyButton text={detail.token} label="Copy address" />
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
                {formatQuoteUnits(detail.quoteBalance)} / 9,000 {quoteSymbol}
              </span>
            </div>
            <div className="arch-progress" aria-hidden>
              <span style={{ width: `${Math.min(progressPct, 100)}%` }} />
            </div>
          </div>
        ) : null}
      </Card>

      <div className="arch-terminal">
        <Card>
          <MarketPanels
            pool={detail.pool}
            token={detail.token}
            pairToken={detail.pairToken}
            symbol={detail.symbol}
            creator={detail.creator}
          />
        </Card>

        <div className="arch-stack">
          <Card title="Trade">
            <TradePanel token={detail.token} pairToken={detail.pairToken} symbol={detail.symbol} chainKey={chain.key} />
          </Card>

          <TokenMode token={detail.token} />

          <CreatorFees
            token={detail.token}
            creator={detail.creator}
            pairToken={detail.pairToken}
            positionId={detail.positionId}
          />

          <Card title="Market">
            <StatRow label="Market cap" value={`$${formatQuoteUnits(detail.marketCapUnits)}`} />
            <StatRow label="Pool liquidity" value={`${formatQuoteUnits(detail.quoteBalance)} ${quoteSymbol}`} />
            <StatRow label="Graduation" value={`9,000 ${quoteSymbol}`} />
            <StatRow label="Supply" value="1,000,000,000 (fixed)" />
            <StatRow label="Creator" value={`${detail.creator.slice(0, 8)}…`} />
            <p className="arch-note" style={{ marginBottom: 0 }}>
              <a href={`${explorerAddress(chain,  detail.token)}`} target="_blank" rel="noreferrer" style={{ textDecoration: "underline" }}>Token on explorer</a>{" "}
              · <a href={`${explorerAddress(chain,  detail.pool)}`} target="_blank" rel="noreferrer" style={{ textDecoration: "underline" }}>Pool</a>{" "}
              · Position #{detail.positionId.toString()}
            </p>
          </Card>
        </div>
      </div>

      <Card title="Permanent liquidity">
        <p className="arch-note" style={{ margin: 0 }}>
          The full launch supply sits in Uniswap v3 position #{detail.positionId.toString()},
          owned by the Arcanium liquidity vault. It can never be withdrawn or
          transferred — by anyone, including Arcanium. The creator earns a share of
          trading fees for the life of the pool. Graduation at 9,000 {quoteSymbol} is a
          permanent label only.
        </p>
      </Card>
    </div>
  );
}
