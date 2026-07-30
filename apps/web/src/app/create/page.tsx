import { Card, StatRow } from "@arch/ui";
import { CreateForm } from "@/components/CreateForm";

/**
 * Create token — live launch flow. The review facts below are constants of
 * the protocol; the fee is read live from the factory inside the form.
 */
export default function CreateTokenPage() {
  return (
    <div style={{ maxWidth: 640, margin: "0 auto" }}>
      <div style={{ marginBottom: "1.25rem" }}>
        <h1 style={{ margin: 0, fontSize: "1.75rem", fontWeight: 700, letterSpacing: "-0.02em" }}>Create a token</h1>
        <p className="arch-note" style={{ margin: "0.25rem 0 0" }}>
          One transaction mints your token, its Uniswap v3 pool, and permanently locked liquidity.
        </p>
      </div>

      <div className="arch-stack">
        <Card>
          <CreateForm />
        </Card>

        <Card title="What you get">
          <StatRow label="Supply" value="1,000,000,000 (fixed forever)" />
          <StatRow label="Starting market cap" value="≈ $3,000" />
          <StatRow label="Pool" value="Uniswap v3 · 1% fee tier" />
          <StatRow label="Liquidity" value="Permanently locked" />
          <StatRow label="Creator rewards" value="A share of trading fees, forever" />
          <StatRow label="Pairs with" value="Native Arc USDC" />
          <p className="arch-note" style={{ marginBottom: 0 }}>
            No bonding curve, no pre-market: your token trades on real Uniswap against
            native Arc USDC from its first block. Launching is free — you only pay Arc
            network gas. Nobody — including Arcanium — can ever withdraw the launch
            liquidity. Prices can go down as well as up.
          </p>
        </Card>
      </div>
    </div>
  );
}
