import { CctpBridge } from "@/components/CctpBridge";

export const metadata = { title: "Bridge — Arcanium" };

/**
 * Bridge — native USDC between Base and Arc over Circle CCTP v2. Burn on the
 * source, Circle attests, Arcanium relays the destination mint so arriving
 * users need no gas.
 */
export default function BridgePage() {
  return (
    <div className="arch-stack" style={{ maxWidth: 560, margin: "0 auto" }}>
      <div>
        <h1 style={{ margin: 0, fontSize: "1.75rem", fontWeight: 700, letterSpacing: "-0.02em" }}>Bridge</h1>
        <p className="arch-note" style={{ margin: "0.25rem 0 0" }}>
          Move native USDC between Base and Arc in under a minute — Circle&apos;s official
          CCTP route, no wrapped assets. Arrival is gas-free: Arcanium relays the mint.
        </p>
      </div>

      <section className="arch-card">
        <CctpBridge />
      </section>

      <p className="arch-note" style={{ textAlign: "center", margin: 0 }}>
        Burns and mints are Circle-attested. If a transfer ever stalls mid-way, your
        USDC is never lost — re-running the mint completes it.
      </p>
    </div>
  );
}
