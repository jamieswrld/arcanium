"use client";

import { useState } from "react";
import type { Hex } from "viem";
import { useAccount, usePublicClient, useSwitchChain, useWriteContract } from "wagmi";
import { ARC_TOKEN_LOCKER } from "@arch/chain-config";
import { getChain } from "@/lib/chains";
import { ensureChain } from "@/lib/wagmi";

/**
 * Claim a matured lock.
 *
 * Only ever offered to the beneficiary, and only once the unlock time has
 * passed — but the contract enforces both regardless, so this is about not
 * presenting a button that is guaranteed to revert rather than about security.
 */

const lockerAbi = [
  {
    type: "function",
    name: "claim",
    stateMutability: "nonpayable",
    inputs: [{ name: "lockId", type: "uint256" }],
    outputs: [],
  },
] as const;

export function ClaimLockButton({
  lockId,
  beneficiary,
  status,
}: {
  readonly lockId: string;
  readonly beneficiary: string;
  readonly status: "locked" | "claimable" | "claimed";
}) {
  const chain = getChain("arc");
  const { address, isConnected, chainId } = useAccount();
  const { switchChainAsync } = useSwitchChain();
  const pub = usePublicClient({ chainId: chain.id });
  const { writeContractAsync } = useWriteContract();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const isBeneficiary =
    isConnected && address !== undefined && address.toLowerCase() === beneficiary.toLowerCase();

  if (done) return <p className="arch-note">Claimed. The tokens are in your wallet.</p>;
  if (status === "claimed") return null;

  if (!isBeneficiary) {
    return (
      <p className="arch-note">
        {status === "claimable"
          ? "Matured and waiting for its recipient to claim."
          : "Only the recipient can claim this, and only after the unlock date."}
      </p>
    );
  }

  if (status === "locked") {
    return <p className="arch-note">Not yet. This becomes claimable at the unlock date.</p>;
  }

  async function onClaim(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await ensureChain("arc", chainId, switchChainAsync);
      const hash = await writeContractAsync({
        address: ARC_TOKEN_LOCKER as Hex,
        abi: lockerAbi,
        functionName: "claim",
        args: [BigInt(lockId)],
        chainId: chain.id,
      });
      const receipt = await pub?.waitForTransactionReceipt({ hash });
      if (receipt?.status === "success") setDone(true);
      else setError("The claim transaction reverted.");
    } catch (err) {
      setError(err instanceof Error ? (err.message.split("\n")[0] ?? "Claim failed") : "Claim failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: "grid", gap: "var(--s2)" }}>
      <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void onClaim()}>
        {busy ? "Claiming…" : "Claim tokens"}
      </button>
      {error === null ? null : (
        <p className="arch-note" style={{ color: "var(--negative)" }}>{error}</p>
      )}
    </div>
  );
}
