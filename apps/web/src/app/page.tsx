import { Card, StatRow } from "@arch/ui";
import { BridgeWidget } from "@/components/BridgeWidget";
import { BridgeHistory } from "@/components/BridgeHistory";
import { formatQuoteUnits, getLiveBridgeData } from "@/lib/onchain";

/**
 * Bridge — the default route. The widget is fully live: wallet connection,
 * live fee/limit reads, approve→deposit→destination-confirmation for
 * Base→Arc, and burn→release tracking for Arc→Base. The network status card
 * below proves solvency with live reads from both chains.
 */
// Rendered per-request: the live-status card reads both chains, and build-time
// prerendering would block on RPC latency (and serve stale numbers anyway).
export const dynamic = "force-dynamic";

export default async function BridgePage() {
  const live = await getLiveBridgeData();

  return (
    <div className="arch-stack" style={{ maxWidth: 560, margin: "0 auto" }}>
      <Card>
        <BridgeWidget />
      </Card>

      <section>
        <div className="arch-section-head">
          <h2>Bridge status</h2>
          <span className="arch-note">Recent activity</span>
        </div>
        <Card>
          <BridgeHistory />
        </Card>
      </section>

      <Card title="Live network status">
        <StatRow
          label="Base RPC"
          value={live.base.ok ? `connected · block ${live.base.blockNumber}` : "unreachable"}
        />
        <StatRow
          label="Arc RPC"
          value={live.arc.ok ? `connected · block ${live.arc.blockNumber}` : "unreachable"}
        />
        <StatRow
          label="Arcanium vault (Base)"
          value={live.vault !== null ? live.vault.address : "not deployed yet"}
        />
        {live.vault !== null ? (
          <StatRow
            label="USDC reserve"
            value={`${formatQuoteUnits(live.vault.totalReserve)} USDC`}
          />
        ) : null}
        <StatRow
          label="aUSD supply (Arc)"
          value={
            live.ausd !== null
              ? `${formatQuoteUnits(live.ausd.totalSupply)} aUSD`
              : "not deployed yet"
          }
        />
      </Card>

      <Card title="What is aUSD?">
        <p className="arch-note" style={{ margin: 0 }}>
          aUSD is issued by Arcanium, not Circle, and is not native USDC. Every aUSD
          is backed one-for-one by USDC held in the Arcanium vault on Base after the
          deposit fee, and the reserve and supply above are read live from both
          chains. When Circle&apos;s native USDC bridge reaches Arc, aUSD
          becomes exchangeable one-for-one for native USDC with no deadline.
        </p>
      </Card>
    </div>
  );
}
