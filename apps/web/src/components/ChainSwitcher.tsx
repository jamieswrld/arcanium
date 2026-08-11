"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { CHAINS, resolveChain, type LaunchChain } from "@/lib/chains";
import { ChainMark } from "@/components/ChainMark";

/**
 * Chain picker for the launchpad. The active chain lives in the URL (`?chain=`)
 * so every page — list, token, create, portfolio — is linkable and server-
 * renderable on the right chain. Chains without a deployed stack are shown but
 * disabled rather than hidden, so the roadmap is visible.
 */
export function ChainSwitcher() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const active = resolveChain(params.get("chain"));
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (wrap.current !== null && !wrap.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function pick(chain: LaunchChain) {
    setOpen(false);
    if (chain.key === active.key) return;
    const next = new URLSearchParams(params.toString());
    next.set("chain", chain.key);
    router.push(`${pathname}?${next.toString()}`);
  }

  return (
    <div ref={wrap} style={{ position: "relative" }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Chain: ${active.name}`}
        className="arch-chain-trigger"
      >
        <ChainMark chain={active} size={16} />
        <span className="arch-chain-trigger-label">{active.shortName}</span>
        <svg width="9" height="9" viewBox="0 0 12 12" fill="none" aria-hidden>
          <path d="M2.5 4.5 6 8l3.5-3.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open ? (
        <div className="arch-chain-menu" role="listbox" aria-label="Select chain">
          {CHAINS.map((c) => {
            const live = c.live && c.factories.length > 0;
            return (
              <button
                key={c.key}
                type="button"
                role="option"
                aria-selected={c.key === active.key}
                disabled={!live}
                onClick={() => pick(c)}
                className={c.key === active.key ? "arch-chain-option arch-chain-option-active" : "arch-chain-option"}
              >
                <ChainMark chain={c} size={20} />
                <span style={{ flex: 1, textAlign: "left" }}>
                  <span style={{ display: "block", fontWeight: 600 }}>{c.name}</span>
                  <span className="arch-note" style={{ fontSize: "0.72rem" }}>
                    {live ? `Pairs with ${c.quote.symbol}` : "Coming soon"}
                  </span>
                </span>
                {c.key === active.key ? (
                  <svg width="13" height="13" viewBox="0 0 14 14" fill="none" aria-hidden>
                    <path d="M2.5 7.5 5.5 10.5 11.5 4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                ) : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
