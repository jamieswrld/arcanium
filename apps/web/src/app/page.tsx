import Link from "next/link";
import { arcPublicClient, fetchAllTokens, formatUsdCompact } from "@/lib/launchpad";
import { fetchTokenImages } from "@/lib/tokenImages";
import { TokenCard } from "@/components/TokenCard";

/**
 * Launchpad landing — hero, live protocol stats, and the launch grid.
 * Everything below the fold is a live chain read.
 */
export const dynamic = "force-dynamic";

export default async function LaunchpadHome() {
  const tokens = await Promise.race([
    fetchAllTokens(arcPublicClient()).catch(() => []),
    new Promise<Awaited<ReturnType<typeof fetchAllTokens>>>((r) => setTimeout(() => r([]), 5000)),
  ]);
  const recent = tokens.slice(0, 6);
  const images = await fetchTokenImages(recent.map((t) => t.token));
  const liquidity = tokens.reduce((acc, t) => acc + t.quoteBalance, 0n);

  return (
    <div>
      <div className="arch-hero">
        <h1>
          Launch a token on Arc.
          <br />
          <span className="arch-gradient-text">Live from block one.</span>
        </h1>
        <p className="arch-note" style={{ fontSize: "1.02rem", maxWidth: 480, margin: "1.1rem auto 0" }}>
          Every token pairs with native USDC on real Uniswap liquidity that&apos;s
          permanently locked.
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
        <div className="arch-stat-grid">
          <div className="arch-stat-tile">
            <div className="arch-stat-label">Tokens launched</div>
            <div className="arch-stat-value">{tokens.length}</div>
          </div>
          <div className="arch-stat-tile">
            <div className="arch-stat-label">Locked liquidity</div>
            <div className="arch-stat-value">{formatUsdCompact(liquidity)}</div>
          </div>
          <div className="arch-stat-tile">
            <div className="arch-stat-label">Launch fee</div>
            <div className="arch-stat-value" style={{ color: "var(--positive)" }}>Free</div>
          </div>
        </div>

        <section>
          <div className="arch-section-head">
            <h2>Recent launches</h2>
            <Link href="/tokens" className="arch-note" style={{ textDecoration: "underline" }}>View all</Link>
          </div>
          {recent.length === 0 ? (
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
                <TokenCard key={t.token} token={t} image={images[t.token.toLowerCase()]} />
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
            <p style={{ margin: "0.35rem 0 0" }}>Buy and sell in native USDC from block one. Creators earn fees forever.</p>
          </div>
        </section>
      </div>
    </div>
  );
}
