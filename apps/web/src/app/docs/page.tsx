import { Card } from "@arch/ui";

/**
 * Documentation index. Full public docs (structure per spec: Overview,
 * Bridge, Launchpad, Integration, Reference) are written across milestones;
 * the disclosures below are permanent and load-bearing from day one.
 */
export default function DocsPage() {
  return (
    <div className="arch-stack">
      <Card title="Arch documentation">
        <ul className="arch-note" style={{ lineHeight: 2 }}>
          <li>Overview</li>
          <li>Bridge — how it works · fees, finality and safety · switching to native USDC</li>
          <li>Launchpad — launching a token · pricing, graduation and fees · aUSD to USDC migration</li>
          <li>Integration — bridging in and out · sponsored gas · indexing and pricing · SDK</li>
          <li>Reference — contract addresses · API · events · security</li>
        </ul>
      </Card>
      <Card title="Plain disclosures">
        <ul className="arch-note" style={{ lineHeight: 1.9 }}>
          <li>aUSD is issued by Arch, not Circle. It is not native USDC.</li>
          <li>aUSD is backed by USDC held in the Arch vault on Base.</li>
          <li>Bridging Base → Arc charges 15%. Redemption is one-for-one and free.</li>
          <li>The bridge is asynchronous; completion means destination confirmation.</li>
          <li>Arc gas is native USDC.</li>
          <li>Launch liquidity is permanently locked. Token prices can still fall.</li>
          <li>Graduation is a permanent display milestone only.</li>
          <li>All trading happens on standard Uniswap v3 pools.</li>
          <li>Quote-side LP fees: 30% to creators, 70% to Arch. Token-side LP fees are burned.</li>
          <li>Smart-contract and operator risks exist. Arch is not endorsed by Circle, Arc, Base, or Uniswap.</li>
        </ul>
      </Card>
    </div>
  );
}
