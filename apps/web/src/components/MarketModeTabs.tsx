"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";

/**
 * Tokens / Stocks selector on the launch page.
 *
 * Stocks does not exist yet and this does not pretend otherwise: selecting it
 * shows a statement of intent and a way back, with no form, no contracts and no
 * inputs that lead nowhere. The state lives in the URL so /create?mode=stocks
 * is linkable and the browser's back button behaves.
 */

export type LaunchMode = "tokens" | "stocks";

export function MarketModeTabs({ mode }: { readonly mode: LaunchMode }) {
  const pathname = usePathname();
  const params = useSearchParams();

  const href = (next: LaunchMode): string => {
    const p = new URLSearchParams(params.toString());
    if (next === "tokens") p.delete("mode");
    else p.set("mode", next);
    const q = p.toString();
    return q === "" ? pathname : `${pathname}?${q}`;
  };

  return (
    <div className="arch-pills mode-tabs" style={{ display: "inline-flex" }}>
      <Link
        href={href("tokens")}
        className={mode === "tokens" ? "arch-pill arch-pill-active" : "arch-pill"}
        aria-current={mode === "tokens" ? "page" : undefined}
      >
        Tokens
      </Link>
      <Link
        href={href("stocks")}
        className={mode === "stocks" ? "arch-pill arch-pill-active" : "arch-pill"}
        aria-current={mode === "stocks" ? "page" : undefined}
      >
        Stocks
        <span className="mode-soon">Soon</span>
      </Link>
    </div>
  );
}

export function StocksComingSoon() {
  return (
    <section className="panel stocks-soon">
      <h2 className="eyebrow">Stocks</h2>
      <p className="stocks-lead">Coming soon to Arcanium.</p>
      <p className="arch-note" style={{ maxWidth: 420 }}>
        New markets built for Arc. Nothing to launch yet — when there is, it will work the way
        token launches do.
      </p>
      <Link href="/create" className="btn btn-primary" style={{ marginTop: "var(--s3)" }}>
        Back to token launch
      </Link>
    </section>
  );
}
