"use client";

import { useEffect, useState } from "react";
import { useAccount, usePublicClient, useSwitchChain, useWriteContract } from "wagmi";
import type { Hex } from "viem";
import { ARC_XCREATOR, ARC_USDC } from "@arch/chain-config";
import { getChain } from "@/lib/chains";
import { ensureChain } from "@/lib/wagmi";

/**
 * Collect creator fees that were routed to an X account.
 *
 * Three steps, and the middle one is the only part that is not ordinary: prove
 * the X account is yours, get a short-lived authorisation for the wallet you
 * are connected with, then submit it. The authorisation names the wallet, and
 * the vault requires the claim to come from that wallet, so nothing here works
 * on somebody else's behalf.
 *
 * Renders nothing until a handle is entered. Most people looking at their
 * portfolio have no X payouts, and a panel explaining a feature they are not
 * using is clutter.
 */

const factoryAbi = [
  {
    type: "function",
    name: "deployVault",
    stateMutability: "nonpayable",
    inputs: [{ type: "bytes32" }],
    outputs: [{ type: "address" }],
  },
] as const;

const vaultAbi = [
  {
    type: "function",
    name: "claim",
    stateMutability: "nonpayable",
    inputs: [
      { name: "asset", type: "address" },
      { name: "recipient", type: "address" },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint256" },
      { name: "signature", type: "bytes" },
    ],
    outputs: [],
  },
] as const;

interface VaultInfo {
  readonly vault: Hex;
  readonly deployed: boolean;
  readonly username: string;
  readonly xUserIdHash: Hex;
  readonly claimable: { readonly units: string; readonly decimals: number };
}

type Phase = "idle" | "looking" | "verifying" | "claiming" | "done" | "error";

export function XRewardClaim() {
  const chain = getChain("arc");
  const { address, isConnected, chainId } = useAccount();
  const { switchChainAsync } = useSwitchChain();
  const pub = usePublicClient({ chainId: chain.id });
  const { writeContractAsync } = useWriteContract();

  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [handle, setHandle] = useState("");
  const [info, setInfo] = useState<VaultInfo | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [verified, setVerified] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/x/config", { cache: "no-store" });
        const body = (await res.json()) as { data?: { enabled?: boolean } };
        if (!cancelled) setEnabled(body.data?.enabled === true);
      } catch {
        if (!cancelled) setEnabled(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Coming back from the OAuth round trip: the callback appends the handle it
  // verified, so the panel can pick the flow back up where it left off.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const v = new URLSearchParams(window.location.search).get("x_verified");
    if (v !== null) {
      setVerified(v);
      setHandle(v);
    }
  }, []);

  if (!isConnected || enabled !== true) return null;

  async function lookup(): Promise<void> {
    const clean = handle.trim().replace(/^@/, "");
    if (clean === "") return;
    setPhase("looking");
    setMessage(null);
    try {
      const res = await fetch(`/api/x/vault?username=${encodeURIComponent(clean)}`, { cache: "no-store" });
      const body = (await res.json()) as { data?: VaultInfo; error?: { message?: string } };
      if (!res.ok || body.data === undefined) {
        setPhase("error");
        setMessage(body.error?.message ?? `Could not find @${clean}.`);
        return;
      }
      setInfo(body.data);
      setPhase("idle");
    } catch {
      setPhase("error");
      setMessage("Could not reach X right now.");
    }
  }

  async function claim(): Promise<void> {
    if (info === null || address === undefined) return;
    setPhase("claiming");
    setMessage(null);
    try {
      // The authorisation names this wallet. Asking for it before switching
      // chains keeps a rejected network switch from burning a nonce.
      const attestRes = await fetch("/api/x/attest", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: ARC_USDC, recipient: address }),
      });
      const att = (await attestRes.json()) as {
        data?: { signature: Hex; nonce: string; deadline: number; vault: Hex };
        error?: { message?: string };
      };
      if (!attestRes.ok || att.data === undefined) {
        setPhase("error");
        setMessage(att.error?.message ?? "Verify your X account first.");
        return;
      }

      await ensureChain("arc", chainId, switchChainAsync);

      // The vault is a CREATE2 address that may not be deployed yet — fees can
      // arrive before it exists. Deploying is idempotent, so this is safe to
      // call whether or not it is already there.
      if (!info.deployed) {
        const dep = await writeContractAsync({
          address: ARC_XCREATOR.factory,
          abi: factoryAbi,
          functionName: "deployVault",
          args: [info.xUserIdHash],
          chainId: chain.id,
        });
        await pub?.waitForTransactionReceipt({ hash: dep });
      }

      const hash = await writeContractAsync({
        address: att.data.vault,
        abi: vaultAbi,
        functionName: "claim",
        args: [ARC_USDC, address, BigInt(att.data.nonce), BigInt(att.data.deadline), att.data.signature],
        chainId: chain.id,
      });
      const receipt = await pub?.waitForTransactionReceipt({ hash });
      if (receipt?.status === "success") {
        setPhase("done");
        setMessage(null);
      } else {
        setPhase("error");
        setMessage("The claim transaction reverted.");
      }
    } catch (err) {
      setPhase("error");
      setMessage(err instanceof Error ? (err.message.split("\n")[0] ?? "Claim failed") : "Claim failed");
    }
  }

  const amount = info === null ? 0n : BigInt(info.claimable.units);
  const human = (Number(amount) / 1e6).toLocaleString("en-US", { maximumFractionDigits: 2 });

  return (
    <section>
      <h2 style={{ margin: "0 0 0.75rem", fontSize: "1.5rem", fontWeight: 700, letterSpacing: "-0.02em" }}>
        X creator rewards
      </h2>
      <section className="arch-card" style={{ display: "grid", gap: "var(--s3)" }}>
        <p className="arch-note" style={{ margin: 0 }}>
          If a launch routed its creator fees to your X account, collect them here.
        </p>

        <div style={{ display: "flex", gap: "var(--s2)", flexWrap: "wrap" }}>
          <input
            className="arch-input"
            value={handle}
            onChange={(e) => {
              setHandle(e.target.value);
              setInfo(null);
            }}
            placeholder="@username"
            spellCheck={false}
            style={{ flex: "1 1 200px" }}
          />
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => void lookup()}
            disabled={phase === "looking" || handle.trim() === ""}
          >
            {phase === "looking" ? "Checking…" : "Check"}
          </button>
        </div>

        {info === null ? null : (
          <div style={{ display: "grid", gap: "var(--s2)" }}>
            <div className="arch-stat-label">Waiting in @{info.username}&apos;s vault</div>
            <div className="num" style={{ fontSize: "1.4rem", fontWeight: 700 }}>
              {human} USDC
            </div>
            <div className="arch-note mono" style={{ wordBreak: "break-all" }}>
              {info.vault}
              {info.deployed ? "" : " · vault not deployed yet, the first claim creates it"}
            </div>

            {amount === 0n ? (
              <p className="arch-note" style={{ margin: 0 }}>
                Nothing to claim yet. Fees arrive here as the token trades.
              </p>
            ) : verified === null ? (
              <a
                className="btn btn-primary"
                href={`/api/x/auth/start?return=${encodeURIComponent("/portfolio")}`}
              >
                Verify @{info.username} on X
              </a>
            ) : (
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => void claim()}
                disabled={phase === "claiming"}
              >
                {phase === "claiming" ? "Claiming…" : `Claim ${human} USDC`}
              </button>
            )}
          </div>
        )}

        {phase === "done" ? (
          <p className="arch-note" style={{ color: "var(--positive)" }}>
            Claimed. The USDC is in your wallet.
          </p>
        ) : null}
        {message === null ? null : (
          <p className="arch-note" style={{ color: "var(--negative)" }}>{message}</p>
        )}

        <p className="arch-note" style={{ margin: 0, fontSize: "0.74rem" }}>
          Verifying with X proves the account is yours. Arcanium never holds these fees — they sit
          in the vault contract until you claim them.
        </p>
      </section>
    </section>
  );
}
