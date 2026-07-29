"use client";

import { useState } from "react";
import { useAccount, useDisconnect, useSwitchChain } from "wagmi";
import { arcTestnet, baseChain } from "@/lib/bridgeClient";
import { ConnectModal } from "@/components/ConnectModal";

function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function NetworkPill() {
  const { chainId, isConnected } = useAccount();
  const { switchChain, isPending } = useSwitchChain();
  if (!isConnected) {
    return <span className="arch-network-pill">Not connected</span>;
  }
  if (chainId === baseChain.id) {
    return (
      <span className="arch-network-pill" style={{ color: "var(--positive)", borderColor: "var(--positive)" }}>
        {baseChain.name}
      </span>
    );
  }
  if (chainId === arcTestnet.id) {
    return (
      <span className="arch-network-pill" style={{ color: "var(--positive)", borderColor: "var(--positive)" }}>
        {arcTestnet.name}
      </span>
    );
  }
  // Wrong network → the pill becomes a one-click fix.
  return (
    <button
      className="arch-network-pill"
      style={{ cursor: "pointer", background: "transparent" }}
      disabled={isPending}
      onClick={() => switchChain({ chainId: baseChain.id })}
      title="Switch to Base"
    >
      {isPending ? "Switching…" : "Wrong network — switch"}
    </button>
  );
}

export function WalletButton() {
  const { address, isConnected } = useAccount();
  const { disconnect } = useDisconnect();
  const [open, setOpen] = useState(false);

  if (isConnected && address !== undefined) {
    return (
      <button className="arch-wallet-button" onClick={() => disconnect()} title="Disconnect">
        {shortAddress(address)}
      </button>
    );
  }

  return (
    <>
      <button className="arch-wallet-button" onClick={() => setOpen(true)}>
        Connect wallet
      </button>
      <ConnectModal open={open} onClose={() => setOpen(false)} />
    </>
  );
}
