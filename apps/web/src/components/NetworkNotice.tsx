"use client";

import { useAccount, useSwitchChain } from "wagmi";
import { arcTestnet } from "@/lib/bridgeClient";

/**
 * Shown when a connected wallet isn't on Arc. Offers one-click switching.
 * wagmi's switchChain triggers wallet_addEthereumChain automatically when Arc
 * is unknown to the wallet, so this also *adds* Arc for first-time users.
 */
export function NetworkNotice() {
  const { isConnected, chainId } = useAccount();
  const { switchChain, isPending } = useSwitchChain();

  if (!isConnected) return null;
  if (chainId === arcTestnet.id) return null;

  return (
    <div
      role="alert"
      className="rounded-xl border border-warning/50 bg-warning/5 p-4 flex flex-col sm:flex-row sm:items-center gap-3"
    >
      <div className="flex-1">
        <div className="font-semibold text-sm">Switch to Arc</div>
        <div className="arch-note">
          Arcanium runs entirely on <strong>Arc</strong>. Switch below — your wallet will add the network if it&apos;s new.
        </div>
      </div>
      <div className="shrink-0">
        <button
          className="arch-wallet-button"
          style={{ cursor: "pointer", opacity: 1 }}
          disabled={isPending}
          onClick={() => switchChain({ chainId: arcTestnet.id })}
        >
          {isPending ? "Switching…" : "Switch to Arc"}
        </button>
      </div>
    </div>
  );
}
