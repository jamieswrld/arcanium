import { Card, StatRow } from "@arch/ui";
import { CreateForm } from "@/components/CreateForm";
import { ArcaneWandIcon, DiviumBillsIcon } from "@/components/ModeIcons";

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


        <Card title="Launch modes">
          <p className="arch-note" style={{ margin: "0 0 0.9rem" }}>
            Optional ways to direct your creator fees, chosen at launch and fixed forever.
            Coming soon.
          </p>
          <div style={{ display: "grid", gap: "0.6rem" }}>
            {[
              {
                icon: <DiviumBillsIcon size={30} />,
                name: "Divium",
                body: "Creator fees are paid out to everyone holding the token, in USDC, pro-rata and continuously. Hold the token, get paid.",
              },
              {
                icon: <ArcaneWandIcon size={30} />,
                name: "Arcane Mode",
                body: "Creator fees automatically buy the token on the open market and burn it to 0xdead — supply drops with every trade.",
              },
              {
                icon: <span style={{ fontSize: 22, lineHeight: 1 }}>⚙️</span>,
                name: "Tax tiers · 1% / 3% / 5% / 10%",
                body: "Pick the trading tax at launch. 1% is the default and keeps the token a plain ERC-20; higher tiers add a tax on pool trades only — wallet transfers are never taxed.",
              },
            ].map((m) => (
              <div
                key={m.name}
                style={{ display: "flex", gap: "0.75rem", alignItems: "flex-start", border: "1px solid var(--border)", borderRadius: 12, padding: "0.75rem 0.85rem", background: "color-mix(in oklch, var(--background) 45%, var(--card))" }}
              >
                <span style={{ marginTop: 2 }}>{m.icon}</span>
                <span style={{ minWidth: 0 }}>
                  <span style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
                    <strong style={{ fontSize: "0.95rem" }}>{m.name}</strong>
                    <span style={{ fontSize: "0.62rem", fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--accent)", border: "1px solid color-mix(in oklch, var(--accent) 45%, transparent)", borderRadius: 999, padding: "0.1rem 0.45rem" }}>
                      Coming soon
                    </span>
                  </span>
                  <span className="arch-note" style={{ display: "block", marginTop: 2 }}>{m.body}</span>
                </span>
              </div>
            ))}
          </div>
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
