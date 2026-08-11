import { Suspense } from "react";
import { Card, StatRow } from "@arch/ui";
import { CreateForm } from "@/components/CreateForm";
import { resolveChain } from "@/lib/chains";

interface CreatePageProps {
  readonly searchParams: Promise<{ chain?: string }>;
}

/**
 * Create token — live launch flow. The review facts below are constants of
 * the protocol; the fee is read live from the factory inside the form. The
 * chain (and therefore the pair asset and gas token) comes from ?chain=.
 */
export default async function CreateTokenPage({ searchParams }: CreatePageProps) {
  const { chain: chainParam } = await searchParams;
  const chain = resolveChain(chainParam);

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
          <Suspense fallback={null}>
            <CreateForm />
          </Suspense>
        </Card>

        <Card title="What you get">
          <StatRow label="Supply" value="1,000,000,000 (fixed forever)" />
          <StatRow label="Starting market cap" value="≈ $3,000" />
          <StatRow label="Pool" value="Uniswap v3 · 1% fee tier" />
          <StatRow label="Liquidity" value="Permanently locked" />
          <StatRow label="Creator rewards" value="A share of trading fees, forever" />
          <StatRow label="Chain" value={chain.name} />
          <StatRow label="Pairs with" value={chain.quote.label} />
          <StatRow label="Gas paid in" value={chain.nativeCurrency.symbol} />
          <p className="arch-note" style={{ marginBottom: 0 }}>
            No bonding curve, no pre-market: your token trades on real Uniswap against{" "}
            {chain.quote.symbol} from its first block. Launching is free — you only pay{" "}
            {chain.name} network gas. Nobody — including Arcanium — can ever withdraw the
            launch liquidity. Prices can go down as well as up.
          </p>
        </Card>
      </div>
    </div>
  );
}
