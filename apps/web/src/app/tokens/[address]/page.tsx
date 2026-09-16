import type { Metadata } from "next";
import Link from "next/link";
import { formatUnits, type Hex } from "viem";
import { arcPublicClient, fetchToken, formatAgeLong, formatPriceE18, formatUsdCompact, isHidden } from "@/lib/launchpad";
import { fetchMarketStats, EMPTY_MARKET } from "@/lib/marketStats";
import { explorerAddress, getChain } from "@/lib/chains";
import { fetchTokenMeta } from "@/lib/tokenImages";
import { withTimeout } from "@/lib/withTimeout";
import { indexedToken } from "@/lib/indexed";
import { TradePanel } from "@/components/TradePanel";
import { MarketPanels } from "@/components/MarketPanels";
import { TokenAvatar } from "@/components/TokenAvatar";
import { LivePrice } from "@/components/LivePrice";
import { CopyButton } from "@/components/CopyButton";
import { TokenPosition } from "@/components/TokenPosition";
import { lockedForToken } from "@/lib/locks";
import { formatAmount } from "@/components/LockTable";
import { CreatorFees } from "@/components/CreatorFees";
import { TokenMode } from "@/components/TokenMode";
import { TokenSocials } from "@/components/TokenSocials";

export const revalidate = 10;

interface TokenPageProps {
  readonly params: Promise<{ address: string }>;
}

/**
 * Token detail — the most important screen in the product.
 *
 * Architecture: identity and market data lead, the chart and its tabs take the
 * main column, and the trading terminal is a persistent companion that stays in
 * view while you read. On mobile the terminal moves directly under the header,
 * because on a phone the reason you opened this page is to trade.
 *
 * Metrics are typography and separators rather than a row of giant cards — five
 * numbers a trader reads together should sit together.
 */
/**
 * Per-token social metadata.
 *
 * The title and description are what a crawler shows beside the generated
 * card. Falling back to the address rather than a generic string keeps a
 * shared link identifiable even when the token cannot be read.
 */
export async function generateMetadata({ params }: TokenPageProps): Promise<Metadata> {
  const { address } = await params;
  const token = /^0x[0-9a-fA-F]{40}$/.test(address)
    ? await fetchToken(arcPublicClient(), address as Hex).catch(() => null)
    : null;
  const label = token === null ? `${address.slice(0, 10)}…` : `${token.symbol}`;
  const desc =
    token === null
      ? "A market on Arcanium, on Arc."
      : `${token.name} — trade ${token.symbol} on Arcanium. Liquidity locked from the first block.`;
  return {
    title: label,
    description: desc,
    openGraph: { title: `${label} — Arcanium`, description: desc },
    twitter: { card: "summary_large_image", title: `${label} — Arcanium`, description: desc },
  };
}

export default async function TokenPage({ params }: TokenPageProps) {
  const { address } = await params;
  const chain = getChain("arc");

  if (!/^0x[0-9a-fA-F]{40}$/.test(address) || isHidden(address)) {
    return <NotFound />;
  }

  // The indexer knows which factory minted this token, so the lookup is a
  // primary key rather than asking all four generations and then making five
  // more reads on whichever one answers.
  const detail =
    (await indexedToken(address).catch(() => null)) ??
    (await withTimeout(fetchToken(arcPublicClient(), address as Hex), null, 10_000, "token detail"));
  if (detail === null) return <NotFound />;

  const [meta, marketMap] = await Promise.all([
    withTimeout(
      fetchTokenMeta(detail.token, chain),
      { image: null, description: null, website: null, twitter: null, telegram: null, discord: null },
      6_000,
      "token metadata",
    ),
    withTimeout(fetchMarketStats([detail], "24h"), new Map(), 9_000, "token market"),
  ]);
  const market = marketMap.get(detail.token.toLowerCase()) ?? EMPTY_MARKET;

  const quote = (v: bigint): string => formatUnits(v, chain.quote.decimals);
  const tokenIsToken0 = detail.token.toLowerCase() < detail.pairToken.toLowerCase();
  const target = chain.graduationUnits;
  const pct = detail.quoteBalance >= target ? 100 : Number((detail.quoteBalance * 100n) / target);
  const launched = formatAgeLong(detail.launchTime);
  const liqUnits =
    chain.quote.decimals >= 6
      ? detail.quoteBalance / 10n ** BigInt(chain.quote.decimals - 6)
      : detail.quoteBalance * 10n ** BigInt(6 - chain.quote.decimals);

  return (
    <div className="stack">
      {/* ---------------------------------------------------------- identity */}
      <section className="panel">
        <div className="tk-head">
          <Link href="/" className="btn btn-ghost" style={{ padding: "0 8px" }} aria-label="Back to markets">
            ‹
          </Link>

          <TokenAvatar image={meta.image} symbol={detail.symbol} size={46} radius={9} />

          <div style={{ minWidth: 0, flex: "1 1 260px" }}>
            <div className="row" style={{ flexWrap: "wrap", gap: "var(--s2)" }}>
              <h1 style={{ fontSize: "1.22rem" }}>{detail.name}</h1>
              <span className="chip">${detail.symbol}</span>
              <span className="chip">Arc</span>
              <span className="chip">/ {chain.quote.symbol}</span>
              {detail.graduated ? <span className="chip chip-pos">Graduated</span> : null}
            </div>

            <div className="row mono" style={{ flexWrap: "wrap", gap: "var(--s2)", marginTop: 5, fontSize: "0.72rem" }}>
              <span style={{ color: "var(--text-muted)" }}>
                {detail.token.slice(0, 10)}…{detail.token.slice(-8)}
              </span>
              <CopyButton text={detail.token} label="Copy address" />
              <a href={explorerAddress(chain, detail.token)} target="_blank" rel="noreferrer" style={{ color: "var(--text-muted)" }}>
                Explorer ↗
              </a>
              <span style={{ color: "var(--text-muted)" }}>
                dev {detail.creator.slice(0, 6)}…{detail.creator.slice(-4)}
              </span>
              {/* Age and holder count are the two facts that most change how a
                  market reads, and both were previously only discoverable by
                  digging. A launch minutes old with four holders is a very
                  different proposition from one that has traded for a month. */}
              {launched === null ? null : (
                <span style={{ color: "var(--text-muted)" }}>launched {launched}</span>
              )}
              {detail.holderCount === null ? null : (
                <span style={{ color: "var(--text-muted)" }}>
                  {detail.holderCount.toLocaleString("en-US")} holder{detail.holderCount === 1 ? "" : "s"}
                </span>
              )}
            </div>

            <TokenSocials meta={meta} />
          </div>

          <div style={{ textAlign: "right", minWidth: 0 }}>
            <div className="arch-token-price-big">
              <LivePrice
                chainKey="arc"
                pool={detail.pool}
                tokenIsToken0={tokenIsToken0}
                initial={formatPriceE18(detail.priceE18)}
              />
            </div>
            <Change pct={market.changePct} />
          </div>
        </div>

        {/* ------------------------------------------------------- metrics */}
        <div className="tk-metrics">
          <Metric label="Market cap" value={formatUsdCompact(detail.marketCapUnits)} />
          <Metric label="24h volume" value={market.trades === 0 ? "—" : formatUsdCompact(market.volumeUnits)} />
          <Metric label="Liquidity" value={formatUsdCompact(liqUnits)} />
          <Metric label="24h trades" value={market.trades === 0 ? "—" : market.trades.toLocaleString("en-US")} />
          <Metric label="Supply" value="1,000,000,000" />
        </div>

        {/* ---------------------------------------------------- graduation */}
        {!detail.graduated ? (
          <div style={{ padding: "0 var(--s4) var(--s4)" }}>
            <div className="spread" style={{ marginBottom: 5 }}>
              <span className="eyebrow">{pct}% to graduation</span>
              <span className="num" style={{ fontSize: "0.74rem", color: "var(--text-muted)" }}>
                {quote(detail.quoteBalance)} / 9,000 {chain.quote.symbol}
              </span>
            </div>
            <span className="grad-track">
              <span className="grad-fill" style={{ width: `${Math.min(pct, 100)}%` }} />
            </span>
          </div>
        ) : null}
      </section>

      {/* ------------------------------------------- market + trade terminal */}
      <div className="tk-grid">
        <div style={{ minWidth: 0, display: "grid", gap: "var(--s4)" }}>
          <section className="panel">
            <div className="panel-body">
              <MarketPanels
                chainKey="arc"
                pool={detail.pool}
                token={detail.token}
                pairToken={detail.pairToken}
                symbol={detail.symbol}
                creator={detail.creator}
              />
            </div>
          </section>

          {meta.description !== null ? (
            <section className="panel">
              <div className="panel-head">
                <span className="eyebrow">About</span>
              </div>
              <div className="panel-body">
                <p className="arch-note" style={{ lineHeight: 1.65 }}>
                  {meta.description}
                </p>
              </div>
            </section>
          ) : null}

          <section className="panel">
            <div className="panel-head">
              <span className="eyebrow">Permanent liquidity</span>
            </div>
            <div className="panel-body">
              <p className="arch-note" style={{ lineHeight: 1.65, margin: 0 }}>
                The entire 1,000,000,000 supply was placed into this Uniswap v3 position at launch
                and the position is held by the Arcanium vault forever. Nobody — including Arcanium
                — can withdraw it. Trading fees accrue to the position and are collected
                separately; the principal never moves.
              </p>
              <p className="arch-note" style={{ marginTop: "var(--s2)", marginBottom: 0 }}>
                <a href={explorerAddress(chain, detail.pool)} target="_blank" rel="noreferrer" style={{ color: "var(--text-secondary)", textDecoration: "underline" }}>
                  Pool contract ↗
                </a>{" "}
                · Position #{detail.positionId.toString()}
              </p>
            </div>
          </section>
        </div>

        {/* The terminal stays with you while the page scrolls. */}
        <aside className="tk-side">
          <section className="panel">
            <div className="panel-head">
              <span className="eyebrow">Trade</span>
              <span className="chip">Market</span>
            </div>
            <div className="panel-body">
              <TradePanel
                token={detail.token}
                pairToken={detail.pairToken}
                symbol={detail.symbol}
                chainKey="arc"
              />
            </div>
          </section>

          {/* Directly under the trade panel: the question "how am I doing here"
              is asked while deciding whether to trade again, not later. Renders
              nothing at all for a wallet with no stake in this market. */}
          <TokenPosition token={detail.token} symbol={detail.symbol} priceE18={detail.priceE18} />

          {/* Allocation locks held in this token, if any. Kept visually and
              verbally apart from "Permanent liquidity" below: that is the
              launch position, locked forever and owned by nobody; these are
              user locks with a recipient and an end date. */}
          <TokenLocks token={detail.token} symbol={detail.symbol} />

          <TokenMode token={detail.token} chainKey="arc" />

          <CreatorFees
            chainKey="arc"
            token={detail.token}
            creator={detail.creator}
            pairToken={detail.pairToken}
            positionId={detail.positionId}
          />
        </aside>
      </div>
    </div>
  );
}

function Metric({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div>
      <div className="arch-stat-label">{label}</div>
      <div className="num" style={{ fontSize: "0.98rem", fontWeight: 650, letterSpacing: "-0.015em" }}>
        {value}
      </div>
    </div>
  );
}

function Change({ pct }: { readonly pct: number | null }) {
  if (pct === null) {
    return (
      <div className="num" style={{ color: "var(--text-muted)", fontSize: "0.8rem" }} title="No trades in the last 24 hours">
        — 24h
      </div>
    );
  }
  const up = pct >= 0;
  return (
    <div className="num" style={{ color: up ? "var(--positive)" : "var(--negative)", fontSize: "0.8rem", fontWeight: 600 }}>
      {up ? "+" : ""}
      {pct.toFixed(2)}% 24h
    </div>
  );
}

function NotFound() {
  return (
    <div className="panel">
      <div className="empty">
        <h3>Not an Arcanium market</h3>
        <p className="arch-note" style={{ maxWidth: 360 }}>
          That address was not launched through Arcanium, so there is no locked-liquidity market
          for it here.
        </p>
        <Link href="/" className="btn btn-primary" style={{ marginTop: "var(--s2)" }}>
          Browse markets
        </Link>
      </div>
    </div>
  );
}

/** Locked allocations for this token. Renders nothing when there are none. */
async function TokenLocks({ token, symbol }: { readonly token: string; readonly symbol: string }) {
  const locked = await lockedForToken(token);
  if (locked === null || locked.locks === 0) return null;
  return (
    <section className="panel" style={{ padding: "var(--s3) var(--s4)" }}>
      <div className="arch-stat-label">Locked allocations</div>
      <div className="num" style={{ fontWeight: 650, marginTop: 2 }}>
        {formatAmount(locked.amount.toString(), 18)} {symbol}
      </div>
      <div className="arch-note">
        across {locked.locks} lock{locked.locks === 1 ? "" : "s"} ·{" "}
        <Link href={`/locked?token=${token}`}>View locks</Link>
      </div>
    </section>
  );
}
