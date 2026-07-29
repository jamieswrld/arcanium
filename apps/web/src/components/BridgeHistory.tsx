"use client";

import { useEffect, useState } from "react";
import { useAccount, usePublicClient } from "wagmi";
import { parseAbiItem, type Hex } from "viem";
import {
  arcTestnet,
  ARC_EXPLORER,
  baseChain,
  BASE_EXPLORER,
  BRIDGE_ADDRESS,
  bridgeAbi,
  bridgeActionId,
  formatQuoteUnits,
  VAULT_ADDRESS,
  vaultAbi,
} from "@/lib/bridgeClient";

interface HistoryRow {
  readonly actionId: Hex;
  readonly direction: "deposit" | "redeem";
  readonly amountIn: bigint;
  readonly amountOut: bigint;
  readonly txHash: Hex;
  readonly completed: boolean;
}

const depositedEvent = parseAbiItem(
  "event Deposited(address indexed sender, address indexed arcRecipient, uint256 grossAmount, uint256 feeAmount, uint256 netAmount, uint256 nonce)",
);
const redeemedEvent = parseAbiItem(
  "event Redeemed(address indexed sender, address indexed baseRecipient, uint256 amount, uint256 nonce)",
);

/**
 * On-chain reconstruction of the connected wallet's recent bridge activity.
 * Completion is proven against the destination chain's processed mappings —
 * a source receipt is never displayed as completion.
 */
export function BridgeHistory() {
  const { address, isConnected } = useAccount();
  const basePublic = usePublicClient({ chainId: baseChain.id });
  const arcPublic = usePublicClient({ chainId: arcTestnet.id });
  const [rows, setRows] = useState<HistoryRow[] | null>(null);
  const [error, setError] = useState<boolean>(false);

  useEffect(() => {
    if (!isConnected || address === undefined || basePublic === undefined || arcPublic === undefined) {
      setRows(null);
      return;
    }
    if (VAULT_ADDRESS === undefined || BRIDGE_ADDRESS === undefined) return;
    const vault = VAULT_ADDRESS;
    const bridge = BRIDGE_ADDRESS;

    let cancelled = false;
    const load = async (): Promise<void> => {
      const collected: HistoryRow[] = [];

      const baseTip = await basePublic.getBlockNumber();
      const baseFrom = baseTip > 15_000n ? baseTip - 15_000n : 0n;
      for (let start = baseFrom; start <= baseTip; start += 1_900n) {
        const end = start + 1_899n < baseTip ? start + 1_899n : baseTip;
        const logs = await basePublic.getLogs({
          address: vault,
          event: depositedEvent,
          args: { sender: address },
          fromBlock: start,
          toBlock: end,
        });
        for (const l of logs) {
          if (l.transactionHash === null || l.logIndex === null || l.args.grossAmount === undefined || l.args.netAmount === undefined) continue;
          const actionId = bridgeActionId(l.transactionHash, BigInt(l.logIndex));
          const completed = await arcPublic.readContract({
            address: bridge,
            abi: bridgeAbi,
            functionName: "processedDeposits",
            args: [actionId],
          });
          collected.push({
            actionId,
            direction: "deposit",
            amountIn: l.args.grossAmount,
            amountOut: l.args.netAmount,
            txHash: l.transactionHash,
            completed,
          });
        }
      }

      const arcTip = await arcPublic.getBlockNumber();
      const arcFrom = arcTip > 40_000n ? arcTip - 40_000n : 0n;
      for (let start = arcFrom; start <= arcTip; start += 1_900n) {
        const end = start + 1_899n < arcTip ? start + 1_899n : arcTip;
        const logs = await arcPublic.getLogs({
          address: bridge,
          event: redeemedEvent,
          args: { sender: address },
          fromBlock: start,
          toBlock: end,
        });
        for (const l of logs) {
          if (l.transactionHash === null || l.logIndex === null || l.args.amount === undefined) continue;
          const actionId = bridgeActionId(l.transactionHash, BigInt(l.logIndex));
          const completed = await basePublic.readContract({
            address: vault,
            abi: vaultAbi,
            functionName: "processedRedemptions",
            args: [actionId],
          });
          collected.push({
            actionId,
            direction: "redeem",
            amountIn: l.args.amount,
            amountOut: l.args.amount,
            txHash: l.transactionHash,
            completed,
          });
        }
      }

      if (!cancelled) {
        setRows(collected.reverse());
        setError(false);
      }
    };
    load().catch(() => {
      if (!cancelled) setError(true);
    });
    return () => {
      cancelled = true;
    };
  }, [address, isConnected, basePublic, arcPublic]);

  if (!isConnected) {
    return (
      <p className="arch-note" style={{ margin: 0 }}>
        Connect your wallet to see your bridge activity with live destination
        confirmations.
      </p>
    );
  }
  if (error) {
    return (
      <p className="arch-note" style={{ margin: 0 }}>
        Couldn&apos;t load history from the RPCs just now — retry shortly.
      </p>
    );
  }
  if (rows === null) {
    return (
      <p className="arch-note" style={{ margin: 0 }}>
        Reading your activity from both chains…
      </p>
    );
  }
  if (rows.length === 0) {
    return (
      <p className="arch-note" style={{ margin: 0 }}>
        No transfers yet. Your deposits and redemptions will appear here.
      </p>
    );
  }
  return (
    <div style={{ display: "grid", gap: "0.5rem" }}>
      {rows.map((row) => (
        <div
          key={row.actionId}
          style={{ display: "flex", justifyContent: "space-between", gap: "0.75rem", fontSize: "0.85rem", flexWrap: "wrap" }}
        >
          <span>
            {row.direction === "deposit"
              ? `${formatQuoteUnits(row.amountIn)} USDC → ${formatQuoteUnits(row.amountOut)} aUSD`
              : `${formatQuoteUnits(row.amountIn)} aUSD → ${formatQuoteUnits(row.amountOut)} USDC`}
          </span>
          <span>
            <a
              href={`${row.direction === "deposit" ? BASE_EXPLORER : ARC_EXPLORER}/tx/${row.txHash}`}
              target="_blank"
              rel="noreferrer"
              style={{ textDecoration: "underline", marginRight: "0.5rem" }}
            >
              tx
            </a>
            <span style={{ color: row.completed ? "var(--arch-positive)" : "var(--arch-warning)" }}>
              {row.completed ? "completed" : "processing"}
            </span>
          </span>
        </div>
      ))}
    </div>
  );
}
