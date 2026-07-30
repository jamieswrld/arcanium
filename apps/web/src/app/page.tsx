import Link from "next/link";
import { Card } from "@arch/ui";
import {
  arcPublicClient,
  fetchAllTokens,
  formatPriceE18,
  GRADUATION_UNITS,
} from "@/lib/launchpad";
import { formatQuoteUnits } from "@/lib/onchain";
import { fetchTokenImages } from "@/lib/tokenImages";
import { TokenAvatar } from "@/components/TokenAvatar";

/**
 * Launchpad landing. Hero + the most recent launches, all live chain reads.
 * Arcanium is a pure Arc launchpad: tokens pair with native Arc USDC and trade
 * on permanently locked Uniswap liquidity from block one.
 */
export const dynamic = "force-dynamic";

export default async function LaunchpadHome() {
  const tokens = await Promise.race([
    fetchAllTokens(arcPublicClient()).catch(() => []),
    new Promise<Awaited<ReturnType<typeof fetchAllTokens>>>((r) => setTimeout(() => r([]), 8000)),
  ]);
  const recent = tokens.slice(0, 6);
  const images = await fetchTokenImages(recent.map((t) => t.token));

  return (
    <div style={{ maxWidth: 720, margin: "0 auto" }}>
      <div className="arch-hero">
        <h1>
          Launch a token on Arc.
          <br />
          <span className="arch-gradient-text">Live from block one.</span>
        </h1>
        <p className="arch-note" style={{ fontSize: "1rem", maxWidth: 460, margin: "1rem auto 0" }}>
          Every token pairs with native Arc USDC on real Uniswap liquidity that&apos;s
          permanently locked — no bonding curve, no pre-market, no rug. Pay with the
          USDC already in your wallet.
        </p>
        <div style={{ display: "flex", gap: "0.75rem", justifyContent: "center", marginTop: "1.5rem", flexWrap: "wrap" }}>
          <Link href="/create" className="arch-primary-button" style={{ width: "auto", padding: "0.8rem 1.6rem", textDecoration: "none" }}>
            Launch a token
          </Link>
          <Link href="/tokens" className="arch-pill" style={{ padding: "0.8rem 1.4rem", border: "1px solid var(--border)", textDecoration: "none" }}>
            Browse all tokens
          </Link>
        </div>
      </div>

      <div className="arch-stack">
        <section>
          <div className="arch-section-head">
            <h2>Recent launches</h2>
            <Link href="/tokens" className="arch-note" style={{ textDecoration: "underline" }}>View all</Link>
          </div>
          <Card>
            {recent.length === 0 ? (
              <div style={{ textAlign: "center", padding: "2.5rem 1rem" }}>
                <div style={{ fontSize: "2rem", marginBottom: "0.5rem" }}>◆</div>
                <p className="arch-note" style={{ margin: 0 }}>No tokens launched yet. Be the first.</p>
                <Link href="/create" className="arch-pill arch-pill-active" style={{ display: "inline-block", marginTop: "1rem", padding: "0.5rem 1.1rem" }}>
                  Launch a token
                </Link>
              </div>
            ) : (
              <div style={{ display: "grid", marginTop: "0.35rem" }}>
                {recent.map((t) => {
                  const progressPct =
                    t.quoteBalance >= GRADUATION_UNITS ? 100 : Number((t.quoteBalance * 100n) / GRADUATION_UNITS);
                  return (
                    <Link key={t.token} href={`/tokens/${t.token}`} className="arch-token-row">
                      <span style={{ display: "flex", alignItems: "center", gap: "0.7rem", minWidth: 0 }}>
                        <TokenAvatar image={images[t.token.toLowerCase()]} symbol={t.symbol} />
                        <span style={{ minWidth: 0 }}>
                          <span style={{ display: "block", fontWeight: 600 }}>{t.symbol}</span>
                          <span className="arch-note" style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {t.name}{t.graduated ? " · graduated" : ` · ${progressPct}%`}
                          </span>
                        </span>
                      </span>
                      <span style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", fontWeight: 500 }}>{formatPriceE18(t.priceE18)}</span>
                      <span style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", fontWeight: 500 }}>${formatQuoteUnits(t.marketCapUnits)}</span>
                    </Link>
                  );
                })}
              </div>
            )}
          </Card>
        </section>

        <section className="arch-steps" style={{ marginTop: "0.5rem" }}>
          <div className="arch-step arch-step-active"><strong>1. Create</strong><br />Name, ticker, image — one transaction.</div>
          <div className="arch-step arch-step-active"><strong>2. Locked liquidity</strong><br />Full supply into a permanent Uniswap position.</div>
          <div className="arch-step arch-step-active"><strong>3. Trade</strong><br />Buy and sell in native USDC from block one.</div>
        </section>
      </div>
    </div>
  );
}
