"use client";

import { useEffect, useMemo, useState } from "react";
import {
  useAccount,
  useConnect,
  usePublicClient,
  useReadContract,
  useSwitchChain,
  useWriteContract,
} from "wagmi";
import type { Hex } from "viem";
import { useToast } from "@/components/ui/Toast";
import { Dialog } from "@/components/ui/Dialog";
import {
  applyBps,
  arcTestnet,
  AUSD_ADDRESS,
  baseChain,
  BRIDGE_ADDRESS,
  bridgeAbi,
  bridgeActionId,
  erc20Abi,
  formatQuoteUnits,
  parseQuoteUnits,
  USDC_ADDRESS,
  VAULT_ADDRESS,
  vaultAbi,
  ARC_EXPLORER,
  BASE_EXPLORER,
} from "@/lib/bridgeClient";

type Direction = "deposit" | "redeem";

type FlowState =
  | { readonly step: "idle" }
  | { readonly step: "switching_network" }
  | { readonly step: "approval_pending"; readonly txHash?: Hex }
  | { readonly step: "signature_pending" }
  | { readonly step: "source_pending"; readonly txHash: Hex }
  | { readonly step: "destination_pending"; readonly txHash: Hex; readonly actionId: Hex }
  | { readonly step: "completed"; readonly txHash: Hex; readonly actionId: Hex }
  | { readonly step: "error"; readonly message: string; readonly retryable: boolean };

const DESTINATION_POLL_MS = 5_000;

export function BridgeWidget() {
  const { address, isConnected, chainId } = useAccount();
  const { connectors, connect } = useConnect();
  const { switchChainAsync } = useSwitchChain();
  const { writeContractAsync } = useWriteContract();
  const basePublic = usePublicClient({ chainId: baseChain.id });
  const arcPublic = usePublicClient({ chainId: arcTestnet.id });

  const { toast } = useToast();
  const [direction, setDirection] = useState<Direction>("deposit");
  const [amountText, setAmountText] = useState<string>("");
  const [flow, setFlow] = useState<FlowState>({ step: "idle" });
  const [reviewOpen, setReviewOpen] = useState(false);

  const configured =
    VAULT_ADDRESS !== undefined && BRIDGE_ADDRESS !== undefined && AUSD_ADDRESS !== undefined;

  // ---- live contract reads -------------------------------------------------
  const feeBps = useReadContract({
    address: VAULT_ADDRESS,
    abi: vaultAbi,
    functionName: "feeBps",
    chainId: baseChain.id,
    query: { enabled: VAULT_ADDRESS !== undefined, refetchInterval: 30_000 },
  });
  const minDeposit = useReadContract({
    address: VAULT_ADDRESS,
    abi: vaultAbi,
    functionName: "minDeposit",
    chainId: baseChain.id,
    query: { enabled: VAULT_ADDRESS !== undefined },
  });
  const maxDeposit = useReadContract({
    address: VAULT_ADDRESS,
    abi: vaultAbi,
    functionName: "maxDeposit",
    chainId: baseChain.id,
    query: { enabled: VAULT_ADDRESS !== undefined },
  });
  const minRedeem = useReadContract({
    address: BRIDGE_ADDRESS,
    abi: bridgeAbi,
    functionName: "minRedeem",
    chainId: arcTestnet.id,
    query: { enabled: BRIDGE_ADDRESS !== undefined },
  });
  const usdcBalance = useReadContract({
    address: USDC_ADDRESS,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: address === undefined ? undefined : [address],
    chainId: baseChain.id,
    query: { enabled: address !== undefined, refetchInterval: 15_000 },
  });
  const ausdBalance = useReadContract({
    address: AUSD_ADDRESS,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: address === undefined ? undefined : [address],
    chainId: arcTestnet.id,
    query: { enabled: address !== undefined && AUSD_ADDRESS !== undefined, refetchInterval: 15_000 },
  });

  // ---- derived amounts (exact bigint math) ---------------------------------
  const parsedAmount = useMemo<bigint | null>(() => {
    if (amountText.trim() === "") return null;
    try {
      return parseQuoteUnits(amountText);
    } catch {
      return null;
    }
  }, [amountText]);

  const fee = feeBps.data ?? null;
  const outputAmount = useMemo<bigint | null>(() => {
    if (parsedAmount === null) return null;
    if (direction === "redeem") return parsedAmount;
    if (fee === null) return null;
    return parsedAmount - applyBps(parsedAmount, fee);
  }, [parsedAmount, direction, fee]);

  const sourceBalance = direction === "deposit" ? usdcBalance.data : ausdBalance.data;
  const sourceSymbol = direction === "deposit" ? "USDC" : "aUSD";
  const destSymbol = direction === "deposit" ? "aUSD" : "USDC";
  const sourceChainName = direction === "deposit" ? "Base Sepolia" : "Arc Testnet";
  const destChainName = direction === "deposit" ? "Arc Testnet" : "Base Sepolia";
  const requiredChainId = direction === "deposit" ? baseChain.id : arcTestnet.id;

  const validationError = useMemo<string | null>(() => {
    if (!configured) return "Bridge contracts are not configured";
    if (parsedAmount === null) return amountText.trim() === "" ? null : "Enter a valid amount";
    if (direction === "deposit") {
      if (minDeposit.data !== undefined && parsedAmount < minDeposit.data) {
        return `Minimum deposit is ${formatQuoteUnits(minDeposit.data)} USDC`;
      }
      if (maxDeposit.data !== undefined && parsedAmount > maxDeposit.data) {
        return `Maximum deposit is ${formatQuoteUnits(maxDeposit.data)} USDC`;
      }
    } else if (minRedeem.data !== undefined && parsedAmount < minRedeem.data) {
      return `Minimum redemption is ${formatQuoteUnits(minRedeem.data)} aUSD`;
    }
    if (sourceBalance !== undefined && parsedAmount > sourceBalance) {
      return `Insufficient ${sourceSymbol} balance`;
    }
    return null;
  }, [configured, parsedAmount, amountText, direction, minDeposit.data, maxDeposit.data, minRedeem.data, sourceBalance, sourceSymbol]);

  // ---- destination polling -------------------------------------------------
  useEffect(() => {
    if (flow.step !== "destination_pending") return;
    const { actionId, txHash } = flow;
    const timer = setInterval(() => {
      const check = async (): Promise<void> => {
        if (direction === "deposit") {
          if (arcPublic === undefined || BRIDGE_ADDRESS === undefined) return;
          const processed = await arcPublic.readContract({
            address: BRIDGE_ADDRESS,
            abi: bridgeAbi,
            functionName: "processedDeposits",
            args: [actionId],
          });
          if (processed) {
            setFlow({ step: "completed", txHash, actionId });
            toast({ tone: "success", title: "Bridge complete", description: "aUSD minted on Arc — verified on the destination chain." });
          }
        } else {
          if (basePublic === undefined || VAULT_ADDRESS === undefined) return;
          const processed = await basePublic.readContract({
            address: VAULT_ADDRESS,
            abi: vaultAbi,
            functionName: "processedRedemptions",
            args: [actionId],
          });
          if (processed) {
            setFlow({ step: "completed", txHash, actionId });
            toast({ tone: "success", title: "Redemption complete", description: "USDC released on Base — verified on the destination chain." });
          }
        }
      };
      check().catch(() => undefined);
    }, DESTINATION_POLL_MS);
    return () => clearInterval(timer);
  }, [flow, direction, arcPublic, basePublic, toast]);

  // ---- actions -------------------------------------------------------------
  async function ensureChain(): Promise<void> {
    if (chainId !== requiredChainId) {
      setFlow({ step: "switching_network" });
      await switchChainAsync({ chainId: requiredChainId });
    }
  }

  async function submit(): Promise<void> {
    if (address === undefined || parsedAmount === null || validationError !== null) return;
    if (VAULT_ADDRESS === undefined || BRIDGE_ADDRESS === undefined) return;
    const vault = VAULT_ADDRESS;
    const bridgeAddr = BRIDGE_ADDRESS;
    try {
      await ensureChain();

      if (direction === "deposit") {
        if (basePublic === undefined) throw new Error("Base RPC unavailable");
        const allowance = await basePublic.readContract({
          address: USDC_ADDRESS,
          abi: erc20Abi,
          functionName: "allowance",
          args: [address, vault],
        });
        if (allowance < parsedAmount) {
          setFlow({ step: "approval_pending" });
          const approveTx = await writeContractAsync({
            address: USDC_ADDRESS,
            abi: erc20Abi,
            functionName: "approve",
            args: [vault, parsedAmount],
            chainId: baseChain.id,
          });
          await basePublic.waitForTransactionReceipt({ hash: approveTx });
        }
        setFlow({ step: "signature_pending" });
        const txHash = await writeContractAsync({
          address: vault,
          abi: vaultAbi,
          functionName: "deposit",
          args: [parsedAmount, address],
          chainId: baseChain.id,
        });
        setFlow({ step: "source_pending", txHash });
        const receipt = await basePublic.waitForTransactionReceipt({ hash: txHash });
        const depositLog = receipt.logs.find(
          (l) => l.address.toLowerCase() === vault.toLowerCase(),
        );
        if (receipt.status !== "success" || depositLog === undefined) {
          setFlow({ step: "error", message: "Deposit transaction failed", retryable: true });
          return;
        }
        const actionId = bridgeActionId(txHash, BigInt(depositLog.logIndex));
        setFlow({ step: "destination_pending", txHash, actionId });
      } else {
        if (arcPublic === undefined) throw new Error("Arc RPC unavailable");
        setFlow({ step: "signature_pending" });
        const txHash = await writeContractAsync({
          address: bridgeAddr,
          abi: bridgeAbi,
          functionName: "redeem",
          args: [parsedAmount, address],
          chainId: arcTestnet.id,
        });
        setFlow({ step: "source_pending", txHash });
        const receipt = await arcPublic.waitForTransactionReceipt({ hash: txHash });
        const redeemLog = receipt.logs.find(
          (l) => l.address.toLowerCase() === bridgeAddr.toLowerCase(),
        );
        if (receipt.status !== "success" || redeemLog === undefined) {
          setFlow({ step: "error", message: "Redemption transaction failed", retryable: true });
          return;
        }
        const actionId = bridgeActionId(txHash, BigInt(redeemLog.logIndex));
        setFlow({ step: "destination_pending", txHash, actionId });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message.split("\n")[0] ?? "failed" : "failed";
      const rejected = message.toLowerCase().includes("rejected");
      setFlow({
        step: "error",
        message: rejected ? "Request rejected in wallet" : message,
        retryable: true,
      });
      toast({ tone: "error", title: rejected ? "Rejected in wallet" : "Transaction failed", description: rejected ? undefined : message });
    }
  }

  function confirmReview(): void {
    setReviewOpen(false);
    toast({ tone: "pending", title: direction === "deposit" ? "Bridging to Arc" : "Redeeming to Base", description: "Follow the prompts in your wallet." });
    submit().catch(() => undefined);
  }

  // ---- render --------------------------------------------------------------
  const busy =
    flow.step === "switching_network" ||
    flow.step === "approval_pending" ||
    flow.step === "signature_pending" ||
    flow.step === "source_pending";

  const buttonLabel = ((): string => {
    if (!isConnected) return "Connect wallet";
    if (flow.step === "switching_network") return `Switch to ${sourceChainName}…`;
    if (flow.step === "approval_pending") return "Approving USDC…";
    if (flow.step === "signature_pending") return "Confirm in wallet…";
    if (flow.step === "source_pending") return "Waiting for confirmation…";
    if (validationError !== null) return validationError;
    if (chainId !== requiredChainId) return `Switch to ${sourceChainName} and ${direction === "deposit" ? "bridge" : "redeem"}`;
    return direction === "deposit" ? "Bridge to Arc" : "Redeem to Base";
  })();

  const sourceExplorer = direction === "deposit" ? BASE_EXPLORER : ARC_EXPLORER;

  return (
    <div>
      <div className="arch-panel">
        <div className="arch-panel-head">
          <span>From</span>
          <span className="arch-chain-chip">{sourceChainName}</span>
        </div>
        <div className="arch-amount-row">
          <input
            className="arch-amount-input"
            placeholder="0.00"
            inputMode="decimal"
            aria-label={`Amount of ${sourceSymbol} to bridge`}
            value={amountText}
            onChange={(e) => setAmountText(e.target.value)}
            disabled={busy}
          />
          <span className="arch-asset-chip">{sourceSymbol}</span>
        </div>
        <div className="arch-panel-foot">
          <span>{parsedAmount !== null ? `$${formatQuoteUnits(parsedAmount)}` : "$0.00"}</span>
          <span>
            Balance: {sourceBalance !== undefined ? formatQuoteUnits(sourceBalance) : "—"} {sourceSymbol}{" "}
            <button
              className="arch-max-chip"
              style={{ cursor: "pointer" }}
              disabled={sourceBalance === undefined || busy}
              onClick={() => {
                if (sourceBalance !== undefined) setAmountText(formatQuoteUnits(sourceBalance).replace(/,/g, ""));
              }}
            >
              Max
            </button>
          </span>
        </div>
      </div>

      <div className="arch-switch-row">
        <button
          className="arch-switch-button"
          style={{ cursor: "pointer" }}
          aria-label="Switch bridge direction"
          disabled={busy}
          onClick={() => {
            setDirection(direction === "deposit" ? "redeem" : "deposit");
            setFlow({ step: "idle" });
          }}
        >
          ⇅
        </button>
      </div>

      <div className="arch-panel">
        <div className="arch-panel-head">
          <span>To</span>
          <span className="arch-chain-chip">{destChainName}</span>
        </div>
        <div className="arch-amount-row">
          <span className="arch-amount-output">
            {outputAmount !== null ? formatQuoteUnits(outputAmount) : "0.00"}
          </span>
          <span className="arch-asset-chip">{destSymbol}</span>
        </div>
        <div className="arch-panel-foot">
          <span>You receive on {destChainName}</span>
        </div>
      </div>

      <div style={{ padding: "0.75rem 0 0.25rem", fontSize: "0.875rem" }}>
        <div style={{ display: "flex", justifyContent: "space-between", padding: "0.25rem 0" }}>
          <span style={{ color: "var(--arch-text-muted)" }}>Rate</span>
          <span>
            {direction === "redeem"
              ? "1 aUSD = 1 USDC"
              : fee !== null
                ? `1 USDC = ${formatQuoteUnits(1_000_000n - applyBps(1_000_000n, fee))} aUSD`
                : "—"}
          </span>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", padding: "0.25rem 0" }}>
          <span style={{ color: "var(--arch-text-muted)" }}>Fee</span>
          <span>
            {direction === "redeem"
              ? "Free"
              : fee !== null
                ? `${(fee / 100n).toString()}%${parsedAmount !== null ? ` (${formatQuoteUnits(applyBps(parsedAmount, fee))} USDC)` : ""}`
                : "—"}
          </span>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", padding: "0.25rem 0" }}>
          <span style={{ color: "var(--arch-text-muted)" }}>Estimated time</span>
          <span>≈ 1 min</span>
        </div>
      </div>

      {!isConnected ? (
        <button
          className="arch-primary-button"
          style={{ cursor: "pointer", opacity: 1 }}
          onClick={() => {
            const connector = connectors[0];
            if (connector !== undefined) connect({ connector });
          }}
        >
          Connect wallet
        </button>
      ) : (
        <button
          className="arch-primary-button"
          style={{
            cursor: busy || validationError !== null || parsedAmount === null ? "not-allowed" : "pointer",
            opacity: busy || validationError !== null || parsedAmount === null ? 0.7 : 1,
          }}
          disabled={busy || validationError !== null || parsedAmount === null}
          onClick={() => {
            if (chainId !== requiredChainId) {
              submit().catch(() => undefined);
            } else {
              setReviewOpen(true);
            }
          }}
        >
          {buttonLabel}
        </button>
      )}

      <Dialog
        open={reviewOpen}
        onClose={() => setReviewOpen(false)}
        title={direction === "deposit" ? "Review bridge to Arc" : "Review redemption"}
        footer={
          <button className="arch-primary-button" onClick={confirmReview}>
            {direction === "deposit" ? "Confirm & bridge" : "Confirm & redeem"}
          </button>
        }
      >
        <div className="text-sm">
          <div className="flex justify-between py-1.5">
            <span className="text-muted-foreground">You send</span>
            <span className="font-medium">
              {parsedAmount !== null ? formatQuoteUnits(parsedAmount) : "—"} {sourceSymbol} on {sourceChainName}
            </span>
          </div>
          <div className="flex justify-between py-1.5">
            <span className="text-muted-foreground">Arch fee</span>
            <span className="font-medium">
              {direction === "redeem"
                ? "Free"
                : fee !== null && parsedAmount !== null
                  ? `${(fee / 100n).toString()}% (${formatQuoteUnits(applyBps(parsedAmount, fee))} USDC)`
                  : "—"}
            </span>
          </div>
          <div className="flex justify-between py-1.5 border-t border-border mt-1 pt-2">
            <span className="text-muted-foreground">You receive</span>
            <span className="font-semibold text-foreground">
              {outputAmount !== null ? formatQuoteUnits(outputAmount) : "—"} {destSymbol} on {destChainName}
            </span>
          </div>
          <p className="arch-note mt-3">
            {direction === "deposit"
              ? "The exact aUSD above is what you receive after the fee. Settlement completes only when Arc confirms the mint (≈ 1 minute)."
              : "Redemption is one-for-one and free. USDC is released on Base after your burn is confirmed."}
          </p>
        </div>
      </Dialog>

      {flow.step === "source_pending" || flow.step === "destination_pending" || flow.step === "completed" ? (
        <div className="arch-note" style={{ marginTop: "0.75rem" }}>
          <div>
            Source transaction:{" "}
            <a href={`${sourceExplorer}/tx/${flow.txHash}`} target="_blank" rel="noreferrer" style={{ textDecoration: "underline" }}>
              {flow.txHash.slice(0, 10)}…
            </a>{" "}
            {flow.step === "source_pending" ? "(confirming…)" : "(confirmed)"}
          </div>
          {flow.step === "destination_pending" ? (
            <div>
              Destination: waiting for the bridge to {direction === "deposit" ? "mint aUSD on Arc" : "release USDC on Base"} —
              this completes only when the destination chain confirms it.
            </div>
          ) : null}
          {flow.step === "completed" ? (
            <div style={{ color: "var(--arch-positive)" }}>
              ✓ Complete — verified on the destination chain (action {flow.actionId.slice(0, 10)}…).
            </div>
          ) : null}
        </div>
      ) : null}

      {flow.step === "error" ? (
        <div className="arch-note" style={{ marginTop: "0.75rem", color: "var(--arch-negative)" }}>
          {flow.message}
          {flow.retryable ? (
            <button
              className="arch-max-chip"
              style={{ marginLeft: "0.5rem", cursor: "pointer" }}
              onClick={() => setFlow({ step: "idle" })}
            >
              Dismiss
            </button>
          ) : null}
        </div>
      ) : null}

      <p className="arch-note" style={{ marginBottom: 0 }}>
        {direction === "deposit"
          ? "Bridging into Arc charges the fee shown above, taken at deposit. The exact aUSD you receive is shown before you sign."
          : "Redemption is free and one-for-one: burning aUSD on Arc releases exactly that much USDC on Base after the burn is confirmed."}
      </p>
    </div>
  );
}
