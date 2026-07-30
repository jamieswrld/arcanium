"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { TokenAvatar } from "@/components/TokenAvatar";

interface IndexToken {
  readonly address: string;
  readonly name: string;
  readonly symbol: string;
  readonly marketCapUsd?: string;
  readonly image?: string | null;
}

interface Item {
  readonly kind: "coin" | "page";
  readonly title: string;
  readonly subtitle: string;
  readonly href: string;
  readonly image?: string | null | undefined;
  readonly symbol?: string | undefined;
  readonly score: number;
}

const PAGES = [
  { title: "Create a coin", subtitle: "launch in one transaction", href: "/create", keys: "create launch new deploy coin token" },
  { title: "Coins", subtitle: "everything launched here", href: "/tokens", keys: "coins tokens launchpad browse list all" },
  { title: "Portfolio", subtitle: "your holdings and creator rewards", href: "/portfolio", keys: "portfolio wallet holdings rewards claim" },
  { title: "Docs", subtitle: "how Arcanium works", href: "/docs", keys: "docs help guide how faq" },
] as const;

/** Best-match scoring: exact symbol ≫ prefix ≫ substring ≫ loose subsequence.
 *  Always surfaces the highest-similarity coin for whatever was typed. */
function score(q: string, symbol: string, name: string): number {
  const s = symbol.toLowerCase();
  const n = name.toLowerCase();
  if (s === q) return 100;
  if (n === q) return 95;
  if (s.startsWith(q)) return 84;
  if (n.startsWith(q)) return 76;
  if (s.includes(q)) return 64;
  if (n.includes(q)) return 56;
  // Subsequence similarity — catches typos/partials, keeps best candidate.
  let qi = 0;
  for (const ch of n + " " + s) {
    if (ch === q[qi]) qi += 1;
    if (qi >= q.length) break;
  }
  return qi >= q.length ? 30 + Math.min(20, Math.round((q.length / Math.max(3, n.length)) * 20)) : 0;
}

let indexCache: IndexToken[] | null = null;

export function SearchCommand() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const [tokens, setTokens] = useState<IndexToken[]>(indexCache ?? []);
  const inputRef = useRef<HTMLInputElement>(null);

  const show = useCallback((): void => {
    setOpen(true);
    setQ("");
    setSel(0);
    if (indexCache === null) {
      fetch("/api/token-info")
        .then((r) => r.json())
        .then((d: { tokens?: IndexToken[] }) => {
          indexCache = d.tokens ?? [];
          setTokens(indexCache);
        })
        .catch(() => undefined);
    }
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => {
          if (!o) show();
          return !o;
        });
      }
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [show]);

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 30);
  }, [open]);

  const items = useMemo<Item[]>(() => {
    const query = q.trim().toLowerCase();
    const coinItems: Item[] = tokens.map((t) => ({
      kind: "coin",
      title: t.name,
      subtitle: `$${t.symbol}${t.marketCapUsd !== undefined ? ` · $${Number(t.marketCapUsd).toLocaleString("en-US")}` : ""}`,
      href: `/tokens/${t.address}`,
      image: t.image,
      symbol: t.symbol,
      score: query === "" ? 50 : score(query, t.symbol, t.name),
    }));
    const pageItems: Item[] = PAGES.map((p) => ({
      kind: "page",
      title: p.title,
      subtitle: p.subtitle,
      href: p.href,
      score: query === "" ? 40 : p.keys.includes(query) || p.title.toLowerCase().includes(query) ? 60 : 0,
    }));
    return [...coinItems, ...pageItems]
      .filter((i) => i.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 8);
  }, [q, tokens]);

  useEffect(() => setSel(0), [q]);

  function go(item: Item | undefined): void {
    if (item === undefined) return;
    setOpen(false);
    router.push(item.href);
  }

  return (
    <>
      <button
        type="button"
        onClick={show}
        aria-label="Search"
        style={{ display: "flex", alignItems: "center", gap: "0.5rem", border: "1px solid var(--border)", borderRadius: 10, background: "color-mix(in oklch, var(--background) 55%, var(--card))", color: "var(--muted-foreground)", padding: "0.42rem 0.8rem", fontSize: "0.82rem", cursor: "pointer" }}
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden>
          <circle cx="11" cy="11" r="7" />
          <path d="m21 21-4-4" />
        </svg>
        <span className="search-hint-text">Search</span>
        <kbd style={{ border: "1px solid var(--border)", borderRadius: 5, padding: "0 0.3rem", fontSize: "0.68rem", fontFamily: "inherit" }}>⌘K</kbd>
      </button>

      {open ? (
        <div
          role="dialog"
          aria-modal
          onClick={() => setOpen(false)}
          style={{ position: "fixed", inset: 0, zIndex: 80, background: "oklch(0.08 0.015 280 / 0.72)", backdropFilter: "blur(6px)", display: "grid", placeItems: "start center", paddingTop: "12vh" }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{ width: "min(640px, 92vw)", background: "var(--card)", border: "1px solid var(--border)", borderRadius: 16, boxShadow: "var(--shadow-lg)", overflow: "hidden" }}
          >
            <input
              ref={inputRef}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => Math.min(s + 1, items.length - 1)); }
                if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); }
                if (e.key === "Enter") go(items[sel]);
              }}
              placeholder="Search coins, or jump to a page…"
              style={{ width: "100%", border: "none", outline: "none", background: "transparent", color: "var(--foreground)", padding: "1rem 1.2rem", fontSize: "1rem", borderBottom: "1px solid var(--border)" }}
            />
            <div style={{ maxHeight: "50vh", overflowY: "auto", padding: "0.4rem" }}>
              {items.length === 0 ? (
                <p className="arch-note" style={{ textAlign: "center", padding: "1.2rem 0" }}>No matches.</p>
              ) : (
                items.map((item, i) => (
                  <button
                    key={item.href + item.title}
                    type="button"
                    onClick={() => go(item)}
                    onMouseEnter={() => setSel(i)}
                    style={{ display: "flex", alignItems: "center", gap: "0.75rem", width: "100%", textAlign: "left", padding: "0.6rem 0.8rem", borderRadius: 12, border: "none", cursor: "pointer", background: i === sel ? "color-mix(in oklch, var(--primary) 16%, transparent)" : "transparent", color: "inherit" }}
                  >
                    {item.kind === "coin" ? (
                      <TokenAvatar image={item.image} symbol={item.symbol ?? "?"} size={34} radius={10} />
                    ) : (
                      <span aria-hidden style={{ width: 34, height: 34, borderRadius: 10, background: "var(--muted)", display: "grid", placeItems: "center", color: "var(--muted-foreground)" }}>→</span>
                    )}
                    <span style={{ minWidth: 0, flex: 1 }}>
                      <span style={{ display: "block", fontWeight: 600, color: i === sel ? "var(--accent)" : "var(--foreground)" }}>{item.title}</span>
                      <span className="arch-note" style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.subtitle}</span>
                    </span>
                    <span className="arch-note" style={{ fontSize: "0.72rem", fontFamily: "monospace", flexShrink: 0 }}>{item.kind === "coin" ? "Coin" : "Page"}</span>
                  </button>
                ))
              )}
            </div>
            <div style={{ display: "flex", gap: "0.9rem", padding: "0.55rem 1rem", borderTop: "1px solid var(--border)" }} className="arch-note">
              <span><kbd>↑</kbd><kbd>↓</kbd> move</span>
              <span><kbd>⏎</kbd> open</span>
              <span><kbd>esc</kbd> close</span>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
