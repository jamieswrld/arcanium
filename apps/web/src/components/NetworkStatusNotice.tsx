import { getChain, type LaunchChain } from "@/lib/chains";

/**
 * Shown when one or more chains cannot be reached. The distinction matters: an
 * unreachable network is not an empty launchpad, and users must not be left
 * thinking their holdings disappeared.
 *
 * Arc gets specific copy because its cause is known and public — Circle is
 * running it as a private mainnet with no public RPC until launch. Any other
 * chain gets an honest generic message rather than a guessed reason.
 */
export function NetworkStatusNotice({ chains }: { readonly chains?: readonly LaunchChain[] }) {
  const affected = chains !== undefined && chains.length > 0 ? chains : [getChain("arc")];
  const names = affected.map((c) => c.name);
  const label =
    names.length === 1
      ? names[0]
      : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  const arcOnly = affected.length === 1 && affected[0]?.key === "arc";

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
          <h2 style={{ margin: 0, fontSize: "1rem", fontWeight: 700 }}>
            {label} temporarily unavailable
          </h2>
          <p className="arch-note" style={{ margin: "0.35rem 0 0", maxWidth: 620 }}>
            {arcOnly ? (
              <>
                Arc is currently operating as a private mainnet, and public RPC access has been
                suspended by the network operator pending its public launch. Arcanium cannot read
                on-chain data until access is restored.
              </>
            ) : (
              <>
                Arcanium cannot currently reach {label}. This is a network connectivity issue on our
                side, not a problem with the chain or with any token on it.
              </>
            )}
          </p>
          <p className="arch-note" style={{ margin: "0.5rem 0 0", maxWidth: 620 }}>
            <strong style={{ color: "var(--foreground)" }}>All tokens, liquidity and balances remain
            secure on-chain.</strong> Nothing has been lost or removed — permanently locked liquidity
            and accrued fees are unaffected. Listings, charts and trading will resume automatically the
            moment network access returns.
          </p>
          {affected.length < 3 ? (
            <p className="arch-note" style={{ margin: "0.5rem 0 0", fontSize: "0.8rem" }}>
              Other chains are unaffected — switch chains above to keep trading.
            </p>
          ) : null}
        </div>
      </div>
    </section>
  );
}
