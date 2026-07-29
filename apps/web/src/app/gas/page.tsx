import { Card } from "@arch/ui";
import { GasWidget } from "@/components/GasWidget";

/**
 * Gas station — live quote → gas-free EIP-2612 permit → relayer drip.
 * The same flow is surfaced inline wherever a transaction lacks Arc gas.
 */
export default function GasPage() {
  return (
    <div className="arch-stack" style={{ maxWidth: 560, margin: "0 auto" }}>
      <div>
        <h1 style={{ margin: "0 0 0.25rem", fontSize: "1.5rem" }}>⛽ Gas</h1>
        <p className="arch-note" style={{ margin: 0 }}>
          Arc charges gas in native USDC. Buy a little with aUSD — you sign a
          gas-free permit and an Arch relayer delivers native USDC to your
          wallet.
        </p>
      </div>

      <Card>
        <GasWidget />
      </Card>

      <p className="arch-note" style={{ textAlign: "center" }}>
        Gas is priced from the live network rate plus a visible 5% Arch service
        margin, which covers fronting native USDC through the relayer. If you
        can bridge USDC directly, that is cheaper.
      </p>
    </div>
  );
}
