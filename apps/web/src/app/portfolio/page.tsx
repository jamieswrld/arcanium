import { Card } from "@arch/ui";

/**
 * Portfolio (parity: Envelope's Portfolio tab, §8.3b) — total-value summary
 * card plus a Positions table. Balances, positions, and bridge history wire
 * up in Milestones 3 and 7.
 */
export default function PortfolioPage() {
  return (
    <div className="arch-stack">
      <Card>
        <div style={{ display: "flex", alignItems: "center", gap: "1rem" }}>
          <div
            aria-hidden
            style={{
              width: 56,
              height: 56,
              borderRadius: 14,
              background: "var(--arch-surface-muted)",
              border: "1px solid var(--arch-border)",
            }}
          />
          <div>
            <div className="arch-note">Not connected</div>
            <div style={{ fontSize: "1.75rem", fontWeight: 700 }}>$0.00</div>
          </div>
        </div>
      </Card>

      <section>
        <div className="arch-section-head">
          <h2>Positions</h2>
        </div>
        <Card>
          <div className="arch-token-list-head">
            <span>Asset</span>
            <span>Amount</span>
            <span>Value</span>
          </div>
          <p className="arch-note" style={{ margin: "1rem 0 0", textAlign: "center" }}>
            Connect your wallet to see your positions.
          </p>
        </Card>
      </section>
    </div>
  );
}
