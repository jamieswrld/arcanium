"use client";

import { useCallback, useEffect, useState } from "react";
import { formatQuoteUnits, ARC_EXPLORER, BASE_EXPLORER } from "@/lib/bridgeClient";
import { BASE_DOMAIN, ARC_DOMAIN } from "@/lib/cctp";

export interface BridgeOrder {
  readonly burnTx: string;
  readonly direction: "toArc" | "toBase";
  readonly amount: string; // 6d units sent
  readonly at: number;
  status: "pending" | "attested" | "claimed" | "failed";
  claimTx?: string;
}

const KEY = "arcanium.bridge.orders";

export function loadOrders(): BridgeOrder[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(KEY);
    const list = raw === null ? [] : (JSON.parse(raw) as BridgeOrder[]);
    return Array.isArray(list) ? list.filter((o) => /^0x[0-9a-fA-F]{64}$/.test(o.burnTx)) : [];
  } catch {
    return [];
  }
}
export function saveOrders(list: readonly BridgeOrder[]): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(KEY, JSON.stringify(list.slice(0, 25)));
  window.dispatchEvent(new Event("arcanium:orders"));
}
export function addOrder(o: BridgeOrder): void {
  saveOrders([o, ...loadOrders().filter((x) => x.burnTx !== o.burnTx)]);
}
export function updateOrder(burnTx: string, patch: Partial<BridgeOrder>): void {
  saveOrders(loadOrders().map((o) => (o.burnTx === burnTx ? { ...o, ...patch } : o)));
}

function ago(ms: number): string {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

/**
 * Your transfers — every bridge order this browser has started, with live
 * status. Pending orders are polled and auto-claimed the moment Circle
 * attests, so a slow attestation never needs babysitting.
 */
export function BridgeOrders() {
  const [orders, setOrders] = useState<BridgeOrder[]>([]);
  const [working, setWorking] = useState<string | null>(null);

  const refresh = useCallback(() => setOrders(loadOrders()), []);

  useEffect(() => {
    refresh();
    window.addEventListener("arcanium:orders", refresh);
    window.addEventListener("storage", refresh);
    return () => {
      window.removeEventListener("arcanium:orders", refresh);
      window.removeEventListener("storage", refresh);
    };
  }, [refresh]);

  const claim = useCallback(async (o: BridgeOrder, silent: boolean): Promise<void> => {
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
      if (relay.txHash !== undefined) updateOrder(o.burnTx, { status: "claimed", claimTx: relay.txHash });
      else if (typeof relay.error === "string" && relay.error.includes("Already minted")) updateOrder(o.burnTx, { status: "claimed" });
    } catch { /* transient — next poll retries */ } finally {
      if (!silent) setWorking(null);
    }
  }, []);

  // Auto-claim loop: any still-pending order is retried every 30s.
  useEffect(() => {
    const tick = (): void => {
      for (const o of loadOrders()) {
        if (o.status === "pending" || o.status === "attested") void claim(o, true);
      }
    };
    const t = setInterval(tick, 30_000);
    tick();
    return () => clearInterval(t);
  }, [claim]);

  if (orders.length === 0) return null;

  return (
    <section className="arch-card">
      <div className="arch-section-head" style={{ marginBottom: "0.5rem" }}>
        <h2 style={{ fontSize: "1rem" }}>Your transfers</h2>
        <span className="arch-note" style={{ fontSize: "0.72rem" }}>Auto-claims when Circle attests</span>
      </div>
      <div style={{ display: "grid", gap: "0.15rem" }}>
        {orders.map((o) => {
          const dst = o.direction === "toArc" ? "Arc" : "Base";
          const srcExp = o.direction === "toArc" ? BASE_EXPLORER : ARC_EXPLORER;
          const dstExp = o.direction === "toArc" ? ARC_EXPLORER : BASE_EXPLORER;
          const tone =
            o.status === "claimed" ? "var(--positive)" : o.status === "failed" ? "var(--negative)" : "var(--warning)";
          const label =
            o.status === "claimed" ? "Delivered" : o.status === "failed" ? "Needs retry" : "Waiting for Circle";
          return (
            <div key={o.burnTx} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "0.75rem", padding: "0.6rem 0", borderBottom: "1px solid var(--border)", flexWrap: "wrap" }}>
              <span style={{ minWidth: 0 }}>
                <span style={{ display: "block", fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>
                  {formatQuoteUnits(BigInt(o.amount))} USDC → {dst}
                </span>
                <span className="arch-note" style={{ fontSize: "0.72rem" }}>
                  {ago(o.at)} ·{" "}
                  <a href={`${srcExp}/tx/${o.burnTx}`} target="_blank" rel="noreferrer" style={{ textDecoration: "underline" }}>deposit</a>
                  {o.claimTx !== undefined ? (
                    <>
                      {" · "}
                      <a href={`${dstExp}/tx/${o.claimTx}`} target="_blank" rel="noreferrer" style={{ textDecoration: "underline" }}>claim</a>
                    </>
                  ) : null}
                </span>
              </span>
              <span style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                <span style={{ color: tone, fontSize: "0.78rem", fontWeight: 700 }}>{label}</span>
                {o.status !== "claimed" ? (
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
          );
        })}
      </div>
    </section>
  );
}
