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
          {/* One line, not a paragraph. The summary panel beside the form
              restates the terms in full at the moment they matter — just
              before signing — so repeating them up here only pushed the form
              itself below the fold. */}
          <p className="cf-lede">
            Free to launch. One transaction, {chain.nativeCurrency.symbol} gas only.
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

          {/* Removed: this repeated the launch summary word for word, one
              scroll below it. */}
        </>
      )}
    </div>
  );
}
