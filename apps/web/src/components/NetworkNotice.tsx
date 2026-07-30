"use client";

import { useAccount, useSwitchChain } from "wagmi";
import { arcTestnet, baseChain } from "@/lib/bridgeClient";

/**
 * Shown when a connected wallet is on a chain Arcanium doesn't use. Offers
 * one-click switching. wagmi's switchChain triggers wallet_addEthereumChain
 * automatically when the chain isn't known to the wallet, so this also *adds*
 * Base / Arc for users who have never used them.
 */
export function NetworkNotice() {
  const { isConnected, chainId } = useAccount();
  const { switchChain, isPending } = useSwitchChain();

  if (!isConnected) return null;
  if (chainId === baseChain.id || chainId === arcTestnet.id) return null;

  return (
    <div
      role="alert"
      className="rounded-xl border border-warning/50 bg-warning/5 p-4 flex flex-col sm:flex-row sm:items-center gap-3"
    >
      <div className="flex-1">
        <div className="font-semibold text-sm">Wrong network</div>
        <div className="arch-note">
          Your wallet is on an unsupported network. Arcanium runs on <strong>Arc</strong> — switch below
          and your wallet will add the network if it&apos;s new.
        </div>
      </div>
      <div className="flex gap-2 shrink-0">
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
