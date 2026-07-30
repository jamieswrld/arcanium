"use client";

import { useEffect, useState } from "react";
import { useAccount, usePublicClient, useWriteContract } from "wagmi";
import type { Hex } from "viem";
import { arcTestnet, PAIR_TOKEN_SYMBOL } from "@/lib/bridgeClient";
import { DISTRIBUTOR_ADDRESS, LIQUIDITY_VAULT_ADDRESS } from "@/lib/launchpad";
import { formatQuoteUnits } from "@/lib/onchain";
import { useToast } from "@/components/ui/Toast";

const vaultAbi = [
  { type: "function", name: "collectFees", stateMutability: "nonpayable", inputs: [{ type: "uint256" }], outputs: [{ type: "uint256" }, { type: "uint256" }] },
] as const;
const distributorAbi = [
  { type: "function", name: "creatorShareBps", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "distribute", stateMutability: "nonpayable", inputs: [{ type: "address" }], outputs: [] },
] as const;

/**
 * Creator rewards panel — rendered ONLY for the wallet that owns this token's
 * rewards. Shows the live pending creator share (simulated collect, so it's
 * exact) and claims via the permissionless distributor: one transaction pays
 * the creator share straight to their wallet.
 */
export function CreatorFees({
  token,
  creator,
  pairToken,
  positionId,
}: {
  readonly token: Hex;
  readonly creator: Hex;
  readonly pairToken: Hex;
  readonly positionId: bigint;
}) {
  const { address, isConnected } = useAccount();
  const arcPublic = usePublicClient({ chainId: arcTestnet.id });
  const { writeContractAsync } = useWriteContract();
  const { toast } = useToast();
  const [pending, setPending] = useState<bigint | null>(null);
  const [shareBps, setShareBps] = useState<bigint | null>(null);
  const [claiming, setClaiming] = useState(false);

  const isCreator = isConnected && address !== undefined && address.toLowerCase() === creator.toLowerCase();
  const tokenIsToken0 = token.toLowerCase() < pairToken.toLowerCase();

  useEffect(() => {
    if (!isCreator || arcPublic === undefined || DISTRIBUTOR_ADDRESS === undefined || LIQUIDITY_VAULT_ADDRESS === undefined) return;
    const distributor = DISTRIBUTOR_ADDRESS;
    const vault = LIQUIDITY_VAULT_ADDRESS;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async (): Promise<void> => {
      try {
        const [share, sim] = await Promise.all([
          shareBps === null
            ? arcPublic.readContract({ address: distributor, abi: distributorAbi, functionName: "creatorShareBps" })
            : Promise.resolve(shareBps),
          arcPublic.simulateContract({
            address: vault,
            abi: vaultAbi,
            functionName: "collectFees",
            args: [positionId],
            account: distributor,
          }).then((r) => r.result).catch(() => [0n, 0n] as const),
        ]);
        if (cancelled) return;
        setShareBps(share);
        const quote = tokenIsToken0 ? sim[1] : sim[0];
        setPending((quote * share) / 10_000n);
      } catch { /* transient */ }
      if (!cancelled) timer = setTimeout(() => void tick(), 10_000);
    };
    void tick();
    return () => { cancelled = true; if (timer !== undefined) clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isCreator, arcPublic, positionId, tokenIsToken0]);

  if (!isCreator || DISTRIBUTOR_ADDRESS === undefined) return null;

  async function claim(): Promise<void> {
    if (arcPublic === undefined || DISTRIBUTOR_ADDRESS === undefined) return;
    setClaiming(true);
    try {
      const txHash = await writeContractAsync({
        address: DISTRIBUTOR_ADDRESS,
        abi: distributorAbi,
        functionName: "distribute",
        args: [token],
        chainId: arcTestnet.id,
      });
      const receipt = await arcPublic.waitForTransactionReceipt({ hash: txHash });
      if (receipt.status === "success") {
        toast({ tone: "success", title: "Rewards claimed", description: "Your creator share was sent to your wallet." });
        setPending(0n);
      } else {
        toast({ tone: "error", title: "Claim failed", description: "The transaction reverted." });
      }
    } catch (err) {
      const message = err instanceof Error ? (err.message.split("\n")[0] ?? "failed") : "failed";
      toast({ tone: "error", title: message.toLowerCase().includes("rejected") ? "Rejected in wallet" : "Claim failed", description: message.toLowerCase().includes("rejected") ? undefined : message });
    } finally {
      setClaiming(false);
    }
  }

  return (
    <section className="arch-card" style={{ borderColor: "color-mix(in oklch, var(--primary) 35%, var(--border))" }}>
      <div className="arch-section-head" style={{ marginBottom: "0.35rem" }}>
        <h2 style={{ fontSize: "1rem" }}>Your creator rewards</h2>
      </div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "0.75rem", flexWrap: "wrap" }}>
        <div>
          <div style={{ fontSize: "1.5rem", fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>
            {pending !== null ? `${formatQuoteUnits(pending)} ${PAIR_TOKEN_SYMBOL}` : "…"}
          </div>
          <div className="arch-note">
            Your share of this token&apos;s trading rewards, earned for as long as it trades
          </div>
        </div>
        <button
          className="arch-primary-button"
          style={{ width: "auto", padding: "0.65rem 1.4rem", cursor: claiming || pending === null || pending === 0n ? "not-allowed" : "pointer", opacity: claiming || pending === null || pending === 0n ? 0.6 : 1 }}
          disabled={claiming || pending === null || pending === 0n}
          onClick={() => void claim()}
        >
          {claiming ? "Claiming…" : "Claim fees"}
        </button>
      </div>
    </section>
  );
}
