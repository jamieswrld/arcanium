import { Card } from "@arch/ui";
import { BridgeWidget } from "@/components/BridgeWidget";
import { BridgeHistory } from "@/components/BridgeHistory";
import { formatQuoteUnits, getLiveBridgeData } from "@/lib/onchain";

/**
 * Bridge — the default route and landing. Hero + live bridge widget, a
 * solvency proof strip, and recent activity. All figures are live chain reads.
 */
export const dynamic = "force-dynamic";

export default async function BridgePage() {
  const live = await getLiveBridgeData();
  const backed =
    live.vault !== null && live.ausd !== null && live.vault.totalReserve >= live.ausd.totalSupply;

  return (
    <div style={{ maxWidth: 620, margin: "0 auto" }}>
      <div className="arch-hero">
        <h1>
          Move USDC to Arc.
          <br />
          <span className="arch-gradient-text">Launch anything.</span>
        </h1>
        <p className="arch-note" style={{ fontSize: "1rem", maxWidth: 440, margin: "1rem auto 0" }}>
          Bridge Base USDC into aUSD, then launch or trade tokens that live on permanently
          locked Uniswap liquidity from block one.
        </p>
      </div>

      <div className="arch-stack">
        <Card>
          <BridgeWidget />
        </Card>

        {/* Solvency proof strip */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: "0.75rem" }}>
          <div className="arch-stat-tile">
            <div className="arch-stat-label">USDC reserve</div>
            <div className="arch-stat-value">
              {live.vault !== null ? `$${formatQuoteUnits(live.vault.totalReserve)}` : "—"}
            </div>
          </div>
          <div className="arch-stat-tile">
            <div className="arch-stat-label">aUSD supply</div>
            <div className="arch-stat-value">
              {live.ausd !== null ? formatQuoteUnits(live.ausd.totalSupply) : "—"}
            </div>
          </div>
          <div className="arch-stat-tile">
            <div className="arch-stat-label">Backing</div>
            <div className="arch-stat-value" style={{ color: backed ? "var(--positive)" : "var(--warning)" }}>
              {backed ? "1:1 ✓" : "—"}
            </div>
          </div>
        </div>

        <section>
          <div className="arch-section-head">
            <h2>Your activity</h2>
            <span className="arch-note">Recent transfers</span>
          </div>
          <Card>
            <BridgeHistory />
          </Card>
        </section>

        <Card title="What is aUSD?">
          <p className="arch-note" style={{ margin: 0 }}>
            aUSD is issued by Arcanium, not Circle, and is not native USDC. Every aUSD is
            backed one-for-one by USDC held in the Arcanium vault on Base after the deposit
            fee — the reserve and supply above are read live from both chains. When
            Circle&apos;s native USDC bridge reaches Arc, aUSD becomes exchangeable
            one-for-one for native USDC with no deadline.
          </p>
        </Card>
      </div>
    </div>
  );
}
