import { Suspense } from "react";
import Link from "next/link";
import { CreateForm } from "@/components/CreateForm";
import { getChain } from "@/lib/chains";

export const metadata = { title: "Create a token — Arcanium" };

/**
 * Create.
 *
 * The form carries its own two-column layout (fields left, persistent launch
 * summary right) because the summary reflects live form state. This page only
 * supplies the heading and the one thing a creator needs to know before they
 * start: what it costs and what they get.
 */
export default function CreateTokenPage() {
  const chain = getChain("arc");

  return (
    <div className="stack">
      <header className="spread" style={{ alignItems: "flex-end", flexWrap: "wrap", gap: "var(--s4)" }}>
        <div style={{ minWidth: 0 }}>
          <h1>Create a token</h1>
          <p className="arch-note" style={{ marginTop: 6, maxWidth: 620 }}>
            One transaction mints your token, opens its Uniswap v3 pool and locks the liquidity
            permanently. Launching is free — you pay {chain.nativeCurrency.symbol} gas and nothing
            else.
          </p>
        </div>
        <Link href="/docs" className="btn btn-secondary" style={{ flexShrink: 0 }}>
          How it works
        </Link>
      </header>

      <Suspense fallback={<div className="skeleton" style={{ height: 520 }} />}>
        <CreateForm />
      </Suspense>

      <p className="arch-note" style={{ fontSize: "0.76rem", maxWidth: 720 }}>
        Every launch pairs with {chain.quote.label} at a starting market cap of roughly $3,000. The
        full 1,000,000,000 supply goes into the pool as a single locked position — nobody, including
        Arcanium, can withdraw it. Your creator fee mode is fixed at launch and can never be changed.
      </p>
    </div>
  );
}
