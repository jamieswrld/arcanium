"use client";

import { useEffect, useState } from "react";

/**
 * Detects when a newer build has been deployed while this tab was open and
 * shows a refresh banner. Prevents users from transacting against stale
 * contract addresses baked into an old bundle.
 */
export function VersionGuard() {
  const [stale, setStale] = useState(false);

  useEffect(() => {
    let initial: string | null = null;
    let cancelled = false;
    const check = async (): Promise<void> => {
      try {
        const res = await fetch("/api/version", { cache: "no-store" });
        const { version } = (await res.json()) as { version: string };
        if (cancelled || typeof version !== "string") return;
        if (initial === null) initial = version;
        else if (version !== initial) setStale(true);
      } catch { /* offline — ignore */ }
    };
    void check();
    const timer = setInterval(() => void check(), 60_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, []);

  if (!stale) return null;
  return (
    <div
      role="status"
      style={{ position: "fixed", bottom: 16, left: "50%", transform: "translateX(-50%)", zIndex: 60, background: "var(--card)", border: "1px solid var(--border)", borderRadius: 12, boxShadow: "var(--shadow-lg)", padding: "0.6rem 0.9rem", display: "flex", gap: "0.75rem", alignItems: "center" }}
    >
      <span style={{ fontSize: "0.85rem" }}>Arcanium was updated.</span>
      <button className="arch-wallet-button" style={{ cursor: "pointer" }} onClick={() => window.location.reload()}>
        Refresh
      </button>
    </div>
  );
}
