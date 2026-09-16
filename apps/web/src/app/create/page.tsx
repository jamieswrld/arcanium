import { Suspense } from "react";
import Link from "next/link";
import { CreateForm } from "@/components/CreateForm";
import { MarketModeTabs, StocksComingSoon, type LaunchMode } from "@/components/MarketModeTabs";
import { getChain } from "@/lib/chains";

export const metadata = { title: "Create a token — Arcanium" };

/** Deep-linkable: /create?mode=stocks. Anything unrecognised falls back to
 *  tokens rather than showing an empty page. */
interface CreateProps {
  readonly searchParams: Promise<{ mode?: string }>;
}

/**
 * Create.
 *
 * The form carries its own two-column layout (fields left, persistent launch
 * summary right) because the summary reflects live form state. This page only
 * supplies the heading and the one thing a creator needs to know before they
 * start: what it costs and what they get.
 */
export default async function CreateTokenPage({ searchParams }: CreateProps) {
  const chain = getChain("arc");
  const sp = await searchParams;
  const mode: LaunchMode = sp.mode === "stocks" ? "stocks" : "tokens";

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
          <div style={{ marginTop: "var(--s3)" }}>
            <Suspense fallback={null}>
              <MarketModeTabs mode={mode} />
            </Suspense>
          </div>
        </div>
        <Link href="/docs" className="btn btn-secondary" style={{ flexShrink: 0 }}>
          How it works
        </Link>
      </header>

      {mode === "stocks" ? (
        <StocksComingSoon />
      ) : (
        <>
          <Suspense fallback={<div className="skeleton" style={{ height: 520 }} />}>
            <CreateForm />
          </Suspense>

          <p className="arch-note" style={{ fontSize: "0.76rem", maxWidth: 720 }}>
            Every launch pairs with {chain.quote.label} at a starting market cap of roughly $3,000.
            The full 1,000,000,000 supply goes into the pool as a single locked position — nobody,
            including Arcanium, can withdraw it. Your creator fee mode is fixed at launch and can
            never be changed.
          </p>
        </>
      )}
    </div>
  );
}
