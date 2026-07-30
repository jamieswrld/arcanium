"use client";

import { useCallback, useEffect, useState } from "react";
import { useAccount } from "wagmi";
import { formatQuoteUnits, ARC_EXPLORER, BASE_EXPLORER } from "@/lib/bridgeClient";
import { BASE_DOMAIN, ARC_DOMAIN } from "@/lib/cctp";

interface ChainOrder {
  readonly burnTx: string;
  readonly direction: "toArc" | "toBase";
  readonly amountIn: string;
  readonly amountBridged: string;
  readonly confirmations: number;
  readonly requiredConfirmations: number;
  readonly status: "confirming" | "attesting" | "claimable" | "claimed";
}

/** Locally-known claims, so a delivered transfer stops showing as pending
 *  even before the next chain scan. */
const CLAIMED_KEY = "arcanium.bridge.claimed";
function loadClaimed(): Record<string, string> {
  if (typeof window === "undefined") return {};
  try { return JSON.parse(window.localStorage.getItem(CLAIMED_KEY) ?? "{}") as Record<string, string>; } catch { return {}; }
}
function markClaimed(burnTx: string, claimTx: string): void {
  if (typeof window === "undefined") return;
  const all = loadClaimed();
  all[burnTx] = claimTx;
  window.localStorage.setItem(CLAIMED_KEY, JSON.stringify(all));
  window.dispatchEvent(new Event("arcanium:orders"));
}

/**
 * Your transfers — recovered from chain state for the connected wallet, so
 * pending deposits show up on any device even if this browser never saw them.
 * Confirmations are displayed live, and anything attested is auto-claimed.
 */
export function BridgeOrders() {
  const { address, isConnected } = useAccount();
  const [orders, setOrders] = useState<ChainOrder[]>([]);
  const [claimed, setClaimed] = useState<Record<string, string>>({});
  const [working, setWorking] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setClaimed(loadClaimed());
    const h = (): void => setClaimed(loadClaimed());
    window.addEventListener("arcanium:orders", h);
    return () => window.removeEventListener("arcanium:orders", h);
  }, []);

  const load = useCallback(async (): Promise<ChainOrder[]> => {
    if (address === undefined) return [];
    setLoading(true);
    try {
      const res = await fetch(`/api/bridge/orders?address=${address}`).then((r) => r.json());
      const list: ChainOrder[] = Array.isArray(res.orders) ? res.orders : [];
      setOrders(list);
      return list;
    } catch {
      return [];
    } finally {
      setLoading(false);
    }
  }, [address]);

  const claim = useCallback(async (o: ChainOrder, silent: boolean): Promise<void> => {
    if (!silent) setWorking(o.burnTx);
    try {
      const domain = o.direction === "toArc" ? BASE_DOMAIN : ARC_DOMAIN;
      const att = await fetch(`/api/bridge/attest?domain=${domain}&tx=${o.burnTx}`).then((r) => r.json());
      if (att.status !== "complete") return;
      const relay = await fetch("/api/bridge/relay", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chain: o.direction === "toArc" ? "arc" : "base", message: att.message, attestation: att.attestation }),
      }).then((r) => r.json());
      if (relay.txHash !== undefined) markClaimed(o.burnTx, relay.txHash);
      else if (typeof relay.error === "string" && relay.error.includes("Already minted")) markClaimed(o.burnTx, "");
    } catch { /* transient — next poll retries */ } finally {
      if (!silent) setWorking(null);
    }
  }, []);

  // Poll chain state; auto-claim anything Circle has attested.
  useEffect(() => {
    if (!isConnected || address === undefined) { setOrders([]); return; }
    let cancelled = false;
    const tick = async (): Promise<void> => {
      const list = await load();
      if (cancelled) return;
      const done = loadClaimed();
      for (const o of list) {
        if (o.status === "claimable" && done[o.burnTx] === undefined) await claim(o, true);
      }
    };
    void tick();
    const t = setInterval(() => void tick(), 20_000);
    return () => { cancelled = true; clearInterval(t); };
  }, [isConnected, address, load, claim]);

  const pending = orders.filter((o) => claimed[o.burnTx] === undefined);
  if (!isConnected) return null;
  if (orders.length === 0) return loading ? null : null;

  return (
    <section className="arch-card">
      <div className="arch-section-head" style={{ marginBottom: "0.5rem" }}>
        <h2 style={{ fontSize: "1rem" }}>Your transfers</h2>
        <span className="arch-note" style={{ fontSize: "0.72rem" }}>
          {pending.length > 0 ? "Auto-claims the moment Circle attests" : "All delivered"}
        </span>
      </div>
      <div style={{ display: "grid", gap: "0.15rem" }}>
        {orders.map((o) => {
          const dst = o.direction === "toArc" ? "Arc" : "Base";
          const srcExp = o.direction === "toArc" ? BASE_EXPLORER : ARC_EXPLORER;
          const dstExp = o.direction === "toArc" ? ARC_EXPLORER : BASE_EXPLORER;
          const claimTx = claimed[o.burnTx];
          const isDone = claimTx !== undefined;
          const pct = Math.min(100, Math.round((o.confirmations / Math.max(1, o.requiredConfirmations)) * 100));
          const label = isDone
            ? "Delivered"
            : o.status === "claimable"
              ? "Claiming now…"
              : o.status === "attesting"
                ? "Circle attesting…"
                : `Confirming ${o.confirmations}/${o.requiredConfirmations} blocks`;
          const tone = isDone ? "var(--positive)" : o.status === "claimable" ? "var(--accent)" : "var(--warning)";
          return (
            <div key={o.burnTx} style={{ padding: "0.65rem 0", borderBottom: "1px solid var(--border)" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "0.75rem", flexWrap: "wrap" }}>
                <span style={{ minWidth: 0 }}>
                  <span style={{ display: "block", fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>
                    {formatQuoteUnits(BigInt(o.amountBridged))} USDC → {dst}
                  </span>
                  <span className="arch-note" style={{ fontSize: "0.72rem" }}>
                    <a href={`${srcExp}/tx/${o.burnTx}`} target="_blank" rel="noreferrer" style={{ textDecoration: "underline" }}>deposit</a>
                    {isDone && claimTx !== "" ? (
                      <>
                        {" · "}
                        <a href={`${dstExp}/tx/${claimTx}`} target="_blank" rel="noreferrer" style={{ textDecoration: "underline" }}>claim</a>
                      </>
                    ) : null}
                  </span>
                </span>
                <span style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                  <span style={{ color: tone, fontSize: "0.78rem", fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>{label}</span>
                  {!isDone ? (
                    <button
                      className="arch-max-chip"
                      style={{ cursor: "pointer", padding: "0.3rem 0.7rem" }}
                      disabled={working === o.burnTx}
                      onClick={() => void claim(o, false)}
                    >
                      {working === o.burnTx ? "Checking…" : "Claim now"}
                    </button>
                  ) : null}
                </span>
              </div>
              {!isDone && o.status === "confirming" ? (
                <div className="arch-progress" style={{ marginTop: "0.45rem" }} aria-hidden>
                  <span style={{ width: `${pct}%` }} />
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}
