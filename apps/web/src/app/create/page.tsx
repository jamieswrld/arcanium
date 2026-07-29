import { Card, StatRow } from "@arch/ui";
import { CreateForm } from "@/components/CreateForm";

/**
 * Create token — live launch flow. The review facts below are constants of
 * the protocol; the fee is read live from the factory inside the form.
 */
export default function CreateTokenPage() {
  return (
    <div className="arch-stack" style={{ maxWidth: 640, margin: "0 auto" }}>
      <Card title="Create a token">
        <p className="arch-note" style={{ marginTop: "-0.5rem" }}>
          One transaction creates your token, its Uniswap v3 pool, and the
          permanently locked liquidity position.
        </p>
        <CreateForm />
      </Card>

      <Card title="What you get">
        <StatRow label="Supply" value="1,000,000,000 (fixed forever)" />
        <StatRow label="Starting market cap" value="≈ $3,000" />
        <StatRow label="Pool" value="Uniswap v3 · 1% fee tier" />
        <StatRow label="Liquidity" value="Permanently locked" />
        <StatRow label="Your share of quote-side trading fees" value="30%, forever" />
        <StatRow label="Token-side trading fees" value="100% burned" />
        <p className="arch-note" style={{ marginBottom: 0 }}>
          No bonding curve, no pre-market: your token trades on real Uniswap
          from its first block. Nobody — including Arch — can ever withdraw the
          launch liquidity. Prices can go down as well as up.
        </p>
      </Card>
    </div>
  );
}
