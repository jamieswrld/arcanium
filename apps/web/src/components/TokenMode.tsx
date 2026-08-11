"use client";

import { useEffect, useState } from "react";
import { useAccount, usePublicClient, useWriteContract } from "wagmi";
import type { Hex } from "viem";
import { formatUnits } from "viem";
import { getChain, type ChainKey } from "@/lib/chains";
import { modeDistributorAbi, launchTokenAbi } from "@/lib/launchpad";
import { ArcaneWandIcon, DiviumBillsIcon } from "@/components/ModeIcons";
import { useToast } from "@/components/ui/Toast";

/**
 * Launch-mode panel. Reads the token's immutable mode from the distributor and
 * renders what it means — plus, for Divium tokens, the connected holder's live
 * USDC accrual and a one-click claim. Anyone can also trigger fee collection,
 * which is what pushes new rewards (or burns) through.
 */
export function TokenMode({
  token,
  chainKey = "arc",
}: {
  readonly token: Hex;
  readonly chainKey?: ChainKey;
}) {
  const chain = getChain(chainKey);
  const MODE_DISTRIBUTOR_ADDRESS = chain.modeDistributor;
  const PAIR_TOKEN_SYMBOL = chain.quote.symbol;
  const formatQuoteUnits = (v: bigint): string => formatUnits(v, chain.quote.decimals);
  const { address, isConnected } = useAccount();
  const arc = usePublicClient({ chainId: chain.id });
  const { writeContractAsync } = useWriteContract();
  const { toast } = useToast();

  const [mode, setMode] = useState<number | null>(null);
  const [claimable, setClaimable] = useState<bigint | null>(null);
  const [busy, setBusy] = useState<"claim" | "distribute" | null>(null);
  const [dist, setDist] = useState<Hex | undefined>(MODE_DISTRIBUTOR_ADDRESS);

  useEffect(() => {
    if (arc === undefined || MODE_DISTRIBUTOR_ADDRESS === undefined) return;
    const fallbackDist = MODE_DISTRIBUTOR_ADDRESS;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async (): Promise<void> => {
      try {
        // The token names its own distributor; always talk to that one.
        const own = await arc.readContract({ address: token, abi: launchTokenAbi, functionName: "taxRecipient" }).catch(() => fallbackDist);
        if (!cancelled) setDist(own);
        const isSet = await arc.readContract({ address: own, abi: modeDistributorAbi, functionName: "modeSet", args: [token] });
        if (!isSet) { if (!cancelled) setMode(-1); return; } // pre-v4 launch
        const m = await arc.readContract({ address: own, abi: modeDistributorAbi, functionName: "modeOf", args: [token] });
        if (cancelled) return;
        setMode(Number(m));
        if (Number(m) === 1 && address !== undefined) {
          const c = await arc.readContract({ address: own, abi: modeDistributorAbi, functionName: "claimable", args: [token, address] }).catch(() => 0n);
          if (!cancelled) setClaimable(c);
        }
      } catch { /* transient */ }
      if (!cancelled) timer = setTimeout(() => void tick(), 15_000);
    };
    void tick();
    return () => { cancelled = true; if (timer !== undefined) clearTimeout(timer); };
  }, [arc, token, address]);

  if (mode === null || mode === -1 || mode === 0) return null; // standard needs no panel

  const isDivium = mode === 1;

  async function run(kind: "claim" | "distribute"): Promise<void> {
    if (arc === undefined || MODE_DISTRIBUTOR_ADDRESS === undefined) return;
    const fallbackDist = MODE_DISTRIBUTOR_ADDRESS;
    setBusy(kind);
    try {
      if (dist === undefined) return;
      const hash = await writeContractAsync({
        address: dist,
        abi: modeDistributorAbi,
        functionName: kind === "claim" ? "claimRewards" : "distribute",
        args: [token],
        chainId: chain.id,
      });
      const r = await arc.waitForTransactionReceipt({ hash });
      if (r.status === "success") {
        toast({
          tone: "success",
          title: kind === "claim" ? "Rewards claimed" : "Fees distributed",
          description: kind === "claim"
            ? "Your USDC was sent to your wallet."
            : isDivium ? "New rewards are now accruing to holders." : "Fees bought and burned the token.",
        });
        if (kind === "claim") setClaimable(0n);
      } else {
        toast({ tone: "error", title: "Transaction reverted" });
      }
    } catch (err) {
      const m = err instanceof Error ? (err.message.split("\n")[0] ?? "failed") : "failed";
      toast({ tone: "error", title: m.toLowerCase().includes("rejected") ? "Rejected in wallet" : "Failed", description: m.toLowerCase().includes("rejected") ? undefined : m });
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="arch-card" style={{ borderColor: "color-mix(in oklch, var(--primary) 35%, var(--border))" }}>
      <div style={{ display: "flex", gap: "0.75rem", alignItems: "flex-start" }}>
        <span aria-hidden style={{ marginTop: 2 }}>
          {isDivium ? <DiviumBillsIcon size={30} /> : <ArcaneWandIcon size={30} />}
        </span>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontWeight: 700 }}>{isDivium ? "Divium" : "Arcane Mode"}</div>
          <p className="arch-note" style={{ margin: "0.2rem 0 0" }}>
            {isDivium
              ? "Creator fees from every trade are paid to holders of this token in USDC. Hold the token, earn continuously."
              : "Creator fees from every trade automatically buy this token and burn it to 0xdead — supply falls forever."}
          </p>
        </div>
      </div>

      {isDivium && isConnected ? (
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "0.75rem", flexWrap: "wrap", marginTop: "0.9rem", borderTop: "1px solid var(--border)", paddingTop: "0.85rem" }}>
          <div>
            <div className="arch-stat-label">Your rewards</div>
            <div style={{ fontSize: "1.2rem", fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>
              {claimable !== null ? `${formatQuoteUnits(claimable)} ${PAIR_TOKEN_SYMBOL}` : "…"}
            </div>
          </div>
          <button
            className="arch-primary-button"
            style={{ width: "auto", padding: "0.55rem 1.2rem", cursor: busy !== null || claimable === null || claimable === 0n ? "not-allowed" : "pointer", opacity: busy !== null || claimable === null || claimable === 0n ? 0.6 : 1 }}
            disabled={busy !== null || claimable === null || claimable === 0n}
            onClick={() => void run("claim")}
          >
            {busy === "claim" ? "Claiming…" : "Claim rewards"}
          </button>
        </div>
      ) : null}

      <div style={{ marginTop: "0.7rem" }}>
        <button
          className="arch-max-chip"
          style={{ cursor: busy !== null ? "not-allowed" : "pointer", padding: "0.35rem 0.8rem" }}
          disabled={busy !== null}
          onClick={() => void run("distribute")}
        >
          {busy === "distribute" ? "Working…" : isDivium ? "Push fees to holders" : "Trigger buy & burn"}
        </button>
        <span className="arch-note" style={{ marginLeft: "0.5rem", fontSize: "0.72rem" }}>
          Anyone can run this — it collects the pool&apos;s accrued fees.
        </span>
      </div>
    </section>
  );
}
