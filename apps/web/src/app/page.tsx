import Link from "next/link";
import { arcPublicClient, formatUsdCompact } from "@/lib/launchpad";
import { fetchProtocolStats } from "@/lib/protocolStats";
import { getAllChainTokens } from "@/lib/tokensServer";
import { ChainFilter } from "@/components/ChainFilter";
import { NetworkStatusNotice } from "@/components/NetworkStatusNotice";
import { fetchTokenImages } from "@/lib/tokenImages";
import { withTimeout } from "@/lib/withTimeout";
import { TokenCard } from "@/components/TokenCard";

/**
 * Launchpad landing — hero, live protocol stats, and the launch grid.
 * Everything below the fold is a live chain read.
 */
export const revalidate = 15; // edge-cached HTML; client polling keeps data live

export default async function LaunchpadHome() {
  // Every chain in parallel — one being down never empties the others.
  const results = await getAllChainTokens();
  const tokens = results.flatMap((r) => [...r.tokens]);
  const down = results.filter((r) => r.unreachable);
  // Never say "no tokens launched" while a chain is unreachable - an outage
  // is not an empty pad.
  const unreachable = tokens.length === 0 && down.length > 0;

  const recent = tokens.slice(0, 6);
  // Both are bounded: this page is prerendered, so an unbounded read here is an
  // unbounded build. Stats degrade to zeros rather than failing the deploy.
  const [images, stats] = await Promise.all([
    withTimeout(fetchTokenImages(recent.map((t) => t.token)), {} as Record<string, string>, 4_000, "home images"),
    withTimeout(
      fetchProtocolStats(arcPublicClient(), tokens),
      { trades: 0, volAllUnits: 0n, vol24hUnits: 0n },
      5_000,
      "home protocol stats",
    ),
  ]);
  const graduated = tokens.filter((t) => t.graduated).length;

  return (
    <div>
      <div className="arch-hero">
        <div className="arch-hero-logo" aria-hidden>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/arcanium-mark.png" alt="" width={86} height={68} />
        </div>
        <h1>
          Launch a token anywhere.
          <br />
          <span className="arch-gradient-text">Live from block one.</span>
        </h1>
        <p className="arch-note" style={{ fontSize: "1.02rem", maxWidth: 520, margin: "1.1rem auto 0" }}>
          Launch on Arc, Robinhood or BNB. Every token pairs with a real stablecoin
          on Uniswap liquidity that&apos;s permanently locked.
        </p>
        <div style={{ display: "flex", gap: "0.75rem", justifyContent: "center", marginTop: "1.6rem", flexWrap: "wrap" }}>
          <Link href="/create" className="arch-primary-button" style={{ width: "auto", padding: "0.85rem 1.8rem", textDecoration: "none" }}>
            Launch a token
          </Link>
          <Link href="/tokens" className="arch-pill" style={{ padding: "0.85rem 1.5rem", border: "1px solid var(--border)", textDecoration: "none", borderRadius: 12 }}>
            Browse tokens
          </Link>
        </div>
      </div>

      <div className="arch-stack">
        <div className="arch-stat-bar">
          <div>
            <div className="arch-stat-label">Tokens launched</div>
            <div className="arch-stat-value">{tokens.length}</div>
          </div>
          <div>
            <div className="arch-stat-label">24h volume</div>
            <div className="arch-stat-value">{formatUsdCompact(stats.vol24hUnits)}</div>
          </div>
          <div>
            <div className="arch-stat-label">All-time volume</div>
            <div className="arch-stat-value">{formatUsdCompact(stats.volAllUnits)}</div>
          </div>
          <div>
            <div className="arch-stat-label">Trades</div>
            <div className="arch-stat-value">{stats.trades.toLocaleString("en-US")}</div>
          </div>
          <div>
            <div className="arch-stat-label">Graduated</div>
            <div className="arch-stat-value">{graduated}</div>
          </div>
        </div>

        <section>
          <div className="arch-section-head">
            <h2>Recent launches</h2>
            <Link href="/tokens" className="arch-note" style={{ textDecoration: "underline" }}>View all</Link>
          </div>
          <div style={{ marginBottom: "0.9rem" }}>
            <ChainFilter
              active="all"
              statuses={results.map((r) => ({ key: r.chain.key, unreachable: r.unreachable, count: r.tokens.length }))}
            />
          </div>
          {unreachable ? (
            <NetworkStatusNotice chains={down.map((r) => r.chain)} />
          ) : recent.length === 0 ? (
            <section className="arch-card" style={{ textAlign: "center", padding: "3rem 1rem" }}>
              <div style={{ fontSize: "2rem", marginBottom: "0.5rem" }}>◆</div>
              <p className="arch-note" style={{ margin: 0 }}>No tokens launched yet. Be the first.</p>
              <Link href="/create" className="arch-pill arch-pill-active" style={{ display: "inline-block", marginTop: "1rem", padding: "0.5rem 1.1rem", textDecoration: "none" }}>
                Launch a token
              </Link>
            </section>
          ) : (
            <div className="arch-token-grid">
              {recent.map((t) => (
                <TokenCard
                  key={`${t.chainKey}:${t.token}`}
                  token={t}
                  image={images[t.token.toLowerCase()]}
                  chainKey={t.chainKey}
                />
              ))}
            </div>
          )}
        </section>

        <section className="arch-steps" style={{ marginTop: "0.5rem" }}>
          <div className="arch-step arch-step-active">
            <strong style={{ color: "var(--foreground)" }}>1 · Create</strong>
            <p style={{ margin: "0.35rem 0 0" }}>Name, ticker, logo — one transaction, free apart from gas.</p>
          </div>
          <div className="arch-step arch-step-active">
            <strong style={{ color: "var(--foreground)" }}>2 · Locked liquidity</strong>
            <p style={{ margin: "0.35rem 0 0" }}>The full billion-token supply goes into a permanent Uniswap position.</p>
          </div>
          <div className="arch-step arch-step-active">
            <strong style={{ color: "var(--foreground)" }}>3 · Trade &amp; earn</strong>
            <p style={{ margin: "0.35rem 0 0" }}>Buy and sell in USDC, USDG or USDT from block one. Creators earn fees forever.</p>
          </div>
        </section>
      </div>
    </div>
  );
}
