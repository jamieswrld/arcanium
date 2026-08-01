/**
 * Shown when Arc cannot be reached. The distinction matters: an unreachable
 * network is not an empty launchpad, and users must not be left thinking their
 * holdings disappeared.
 */
export function NetworkStatusNotice() {
  return (
    <section
      className="arch-card"
      role="status"
      style={{ borderColor: "color-mix(in oklch, var(--warning) 45%, var(--border))" }}
    >
      <div style={{ display: "flex", gap: "0.85rem", alignItems: "flex-start" }}>
        <span
          aria-hidden
          style={{
            width: 34, height: 34, borderRadius: 10, flexShrink: 0, display: "grid", placeItems: "center",
            background: "color-mix(in oklch, var(--warning) 18%, transparent)",
            border: "1px solid color-mix(in oklch, var(--warning) 45%, transparent)",
            color: "var(--warning)", fontWeight: 700,
          }}
        >
          !
        </span>
        <div style={{ minWidth: 0 }}>
          <h2 style={{ margin: 0, fontSize: "1rem", fontWeight: 700 }}>Arc network temporarily unavailable</h2>
          <p className="arch-note" style={{ margin: "0.35rem 0 0", maxWidth: 620 }}>
            Arc is currently operating as a private mainnet, and public RPC access has been
            suspended by the network operator pending its public launch. Arcanium cannot read
            on-chain data until access is restored.
          </p>
          <p className="arch-note" style={{ margin: "0.5rem 0 0", maxWidth: 620 }}>
            <strong style={{ color: "var(--foreground)" }}>All tokens, liquidity and balances remain
            secure on-chain.</strong> Nothing has been lost or removed — permanently locked liquidity
            and accrued fees are unaffected. Listings, charts and trading will resume automatically the
            moment network access returns.
          </p>
        </div>
      </div>
    </section>
  );
}
