"use client";

import { useMemo, useState } from "react";
import { useAccount, usePublicClient, useReadContract, useSwitchChain, useWriteContract } from "wagmi";
import { base } from "viem/chains";
import type { Hex } from "viem";
import { arcTestnet, erc20Abi, formatQuoteUnits, parseQuoteUnits, ARC_EXPLORER, BASE_EXPLORER } from "@/lib/bridgeClient";
import {
  addressToBytes32,
  ARC_DOMAIN,
  ARC_USDC,
  BASE_DOMAIN,
  BASE_USDC,
  FAST_FINALITY,
  maxFeeFor,
  BRIDGE_FEE_BPS,
  BRIDGE_ROUTER_ARC,
  BRIDGE_ROUTER_BASE,
  bridgeRouterAbi,
} from "@/lib/cctp";
import { UsdcLogo } from "@/components/UsdcLogo";
import { ConnectButton } from "@/components/ConnectButton";
import { useToast } from "@/components/ui/Toast";

type Direction = "toArc" | "toBase";

type Step =
  | { readonly id: "idle" }
  | { readonly id: "switching" }
  | { readonly id: "approving" }
  | { readonly id: "burning" }
  | { readonly id: "attesting"; readonly burnTx: Hex }
  | { readonly id: "minting"; readonly burnTx: Hex }
  | { readonly id: "done"; readonly burnTx: Hex; readonly mintTx: string }
  | { readonly id: "error"; readonly message: string };

/**
 * Circle CCTP v2 bridge: burn USDC on the source chain, Circle attests, our
 * relayer submits the mint on the destination — so arrival needs no gas there.
 * Native USDC both sides, no wrapped assets, no third-party bridge risk.
 */
export function CctpBridge() {
  const { address, isConnected, chainId } = useAccount();
  const { switchChainAsync } = useSwitchChain();
  const { writeContractAsync } = useWriteContract();
  const basePublic = usePublicClient({ chainId: base.id });
  const arcPublic = usePublicClient({ chainId: arcTestnet.id });
  const { toast } = useToast();

  const [direction, setDirection] = useState<Direction>("toArc");
  const [amountText, setAmountText] = useState("");
  const [step, setStep] = useState<Step>({ id: "idle" });

  const toArc = direction === "toArc";
  const srcChainId = toArc ? base.id : arcTestnet.id;
  const srcName = toArc ? "Base" : "Arc";
  const dstName = toArc ? "Arc" : "Base";
  const srcUsdc = toArc ? BASE_USDC : ARC_USDC;
  const srcRouter = toArc ? BRIDGE_ROUTER_BASE : BRIDGE_ROUTER_ARC;
  const srcExplorer = toArc ? BASE_EXPLORER : ARC_EXPLORER;
  const dstExplorer = toArc ? ARC_EXPLORER : BASE_EXPLORER;

  const baseBal = useReadContract({
    address: BASE_USDC, abi: erc20Abi, functionName: "balanceOf",
    args: address === undefined ? undefined : [address],
    chainId: base.id,
    query: { enabled: address !== undefined, refetchInterval: 10_000 },
  });
  const arcBal = useReadContract({
    address: ARC_USDC, abi: erc20Abi, functionName: "balanceOf",
    args: address === undefined ? undefined : [address],
    chainId: arcTestnet.id,
    query: { enabled: address !== undefined, refetchInterval: 10_000 },
  });

  const srcBalance = toArc ? baseBal.data : arcBal.data;
  const dstBalance = toArc ? arcBal.data : baseBal.data;

  const parsed = useMemo<bigint | null>(() => {
    if (amountText.trim() === "") return null;
    try { return parseQuoteUnits(amountText); } catch { return null; }
  }, [amountText]);

  const receiveAfterFee = parsed === null ? null : parsed - (parsed * BRIDGE_FEE_BPS) / 10_000n;

  const busy = step.id === "switching" || step.id === "approving" || step.id === "burning" || step.id === "attesting" || step.id === "minting";

  async function run(): Promise<void> {
    if (address === undefined || parsed === null || parsed === 0n) {
      setStep({ id: "error", message: "Enter an amount." });
      return;
    }
    if (srcBalance !== undefined && srcBalance < parsed) {
      setStep({ id: "error", message: `Insufficient USDC on ${srcName}.` });
      return;
    }
    const srcPublic = toArc ? basePublic : arcPublic;
    if (srcPublic === undefined) return;
    try {
      if (chainId !== srcChainId) {
        setStep({ id: "switching" });
        await switchChainAsync({ chainId: srcChainId });
      }

      const allowance = await srcPublic.readContract({
        address: srcUsdc, abi: erc20Abi, functionName: "allowance", args: [address, srcRouter],
      });
      if (allowance < parsed) {
        setStep({ id: "approving" });
        const approveTx = await writeContractAsync({
          address: srcUsdc, abi: erc20Abi, functionName: "approve", args: [srcRouter, parsed], chainId: srcChainId,
        });
        await srcPublic.waitForTransactionReceipt({ hash: approveTx });
      }

      setStep({ id: "burning" });
      const burnTx = await writeContractAsync({
        address: srcRouter,
        abi: bridgeRouterAbi,
        functionName: "bridge",
        args: [
          parsed,
          toArc ? ARC_DOMAIN : BASE_DOMAIN,
          addressToBytes32(address),
          maxFeeFor(parsed),
          FAST_FINALITY,
        ],
        chainId: srcChainId,
      });
      const receipt = await srcPublic.waitForTransactionReceipt({ hash: burnTx });
      if (receipt.status !== "success") {
        setStep({ id: "error", message: "Burn transaction reverted." });
        return;
      }

      // Circle attestation — fast transfers land in seconds.
      setStep({ id: "attesting", burnTx });
      const srcDomain = toArc ? BASE_DOMAIN : ARC_DOMAIN;
      let message: string | null = null;
      let attestation: string | null = null;
      const deadline = Date.now() + 5 * 60_000;
      for (;;) {
        const res = await fetch(`/api/bridge/attest?domain=${srcDomain}&tx=${burnTx}`).then((r) => r.json()).catch(() => ({ status: "pending" }));
        if (res.status === "complete") { message = res.message; attestation = res.attestation; break; }
        if (Date.now() > deadline) {
          setStep({ id: "error", message: "Attestation is taking longer than usual. Your funds are safe — retry in a minute and the mint will complete." });
          return;
        }
        await new Promise((r) => setTimeout(r, 3_000));
      }

      // Our relayer pays destination gas — nothing needed from the user.
      setStep({ id: "minting", burnTx });
      const relay = await fetch("/api/bridge/relay", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chain: toArc ? "arc" : "base", message, attestation }),
      }).then((r) => r.json());
      if (relay.txHash === undefined) {
        setStep({ id: "error", message: relay.error ?? "Mint relay failed — retry shortly; your burn is attested and safe." });
        return;
      }
      setStep({ id: "done", burnTx, mintTx: relay.txHash });
      setAmountText("");
      void baseBal.refetch();
      void arcBal.refetch();
      toast({ tone: "success", title: `Bridged to ${dstName}`, description: `Native USDC delivered on ${dstName}.`, href: `${dstExplorer}/tx/${relay.txHash}`, hrefLabel: "View mint" });
    } catch (err) {
      const message = err instanceof Error ? (err.message.split("\n")[0] ?? "failed") : "failed";
      setStep({ id: "error", message: message.toLowerCase().includes("rejected") ? "Rejected in wallet" : message });
    }
  }

  const stepLabel = ((): string => {
    switch (step.id) {
      case "switching": return `Switch to ${srcName}…`;
      case "approving": return "Approving USDC…";
      case "burning": return `Burning on ${srcName}…`;
      case "attesting": return "Circle attesting…";
      case "minting": return `Minting on ${dstName} (gas-free)…`;
      default: return `Bridge to ${dstName}`;
    }
  })();

  const panel = (label: string, chainName: string, balance: bigint | undefined, input: boolean): React.ReactNode => (
    <div className="arch-panel">
      <div className="arch-panel-head">
        <span>{label}</span>
        <span className="arch-chain-chip" style={{ display: "inline-flex", alignItems: "center", gap: "0.4rem" }}>
          <UsdcLogo size={16} /> USDC · {chainName}
        </span>
      </div>
      <div className="arch-amount-row">
        {input ? (
          <input className="arch-amount-input" placeholder="0.00" inputMode="decimal" value={amountText} onChange={(e) => setAmountText(e.target.value)} disabled={busy} aria-label="Amount to bridge" />
        ) : (
          <span className="arch-amount-output">{receiveAfterFee !== null ? formatQuoteUnits(receiveAfterFee) : "0.00"}</span>
        )}
      </div>
      <div className="arch-panel-foot">
        <span>{input ? "You send" : "After fees (Circle's network fee may apply)"}</span>
        <span>
          Balance: {balance !== undefined ? formatQuoteUnits(balance) : "—"}
          {input ? (
            <button
              className="arch-max-chip"
              style={{ marginLeft: "0.4rem" }}
              disabled={balance === undefined || busy}
              onClick={() => { if (balance !== undefined) setAmountText(formatQuoteUnits(balance).replace(/,/g, "")); }}
            >
              Max
            </button>
          ) : null}
        </span>
      </div>
    </div>
  );

  return (
    <div>
      {panel("From", srcName, srcBalance, true)}
      <div className="arch-switch-row">
        <button
          className="arch-switch-button"
          aria-label="Switch direction"
          disabled={busy}
          onClick={() => { setDirection(toArc ? "toBase" : "toArc"); setStep({ id: "idle" }); }}
        >
          ⇅
        </button>
      </div>
      {panel("To", dstName, dstBalance, false)}

      <div style={{ padding: "0.8rem 0 0.2rem", fontSize: "0.85rem" }}>
        <div style={{ display: "flex", justifyContent: "space-between", padding: "0.15rem 0" }}>
          <span style={{ color: "var(--muted-foreground)" }}>Route</span>
          <span>Circle CCTP · native USDC (no wrapped assets)</span>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", padding: "0.15rem 0" }}>
          <span style={{ color: "var(--muted-foreground)" }}>Bridge fee</span>
          <span>2%{parsed !== null ? ` (${formatQuoteUnits((parsed * BRIDGE_FEE_BPS) / 10_000n)} USDC)` : ""}</span>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", padding: "0.15rem 0" }}>
          <span style={{ color: "var(--muted-foreground)" }}>Speed</span>
          <span>~15–60 seconds</span>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", padding: "0.15rem 0" }}>
          <span style={{ color: "var(--muted-foreground)" }}>Destination gas</span>
          <span style={{ color: "var(--positive)" }}>Free — Arcanium relays the mint</span>
        </div>
      </div>

      {!isConnected ? (
        <ConnectButton />
      ) : (
        <button
          className="arch-primary-button"
          style={{ cursor: busy || parsed === null ? "not-allowed" : "pointer", opacity: busy || parsed === null ? 0.65 : 1, marginTop: "0.5rem" }}
          disabled={busy || parsed === null}
          onClick={() => void run()}
        >
          {stepLabel}
        </button>
      )}

      {step.id === "attesting" || step.id === "minting" || step.id === "done" ? (
        <div className="arch-note" style={{ marginTop: "0.75rem" }}>
          <div>
            Burn:{" "}
            <a href={`${srcExplorer}/tx/${step.burnTx}`} target="_blank" rel="noreferrer" style={{ textDecoration: "underline" }}>
              {step.burnTx.slice(0, 10)}… ✓
            </a>
          </div>
          {step.id === "attesting" ? <div>Waiting for Circle&apos;s attestation…</div> : null}
          {step.id === "minting" ? <div>Attested ✓ — relaying the mint on {dstName}…</div> : null}
          {step.id === "done" ? (
            <div style={{ color: "var(--positive)" }}>
              ✓ Minted on {dstName}:{" "}
              <a href={`${dstExplorer}/tx/${step.mintTx}`} target="_blank" rel="noreferrer" style={{ textDecoration: "underline" }}>
                {step.mintTx.slice(0, 10)}…
              </a>
            </div>
          ) : null}
        </div>
      ) : null}
      {step.id === "error" ? (
        <p className="arch-note" style={{ marginTop: "0.75rem", color: "var(--negative)" }}>{step.message}</p>
      ) : null}
    </div>
  );
}
