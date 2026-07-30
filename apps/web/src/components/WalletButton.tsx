"use client";

import { useEffect, useRef, useState } from "react";
import { useAccount, useDisconnect, useSwitchChain } from "wagmi";
import { arcTestnet } from "@/lib/bridgeClient";
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
  if (chainId === arcTestnet.id) {
    return (
      <span className="arch-network-pill" style={{ color: "var(--positive)", borderColor: "var(--positive)" }}>
        {arcTestnet.name}
      </span>
    );
  }
  // Wrong network → the pill becomes a one-click switch to Arc.
  return (
    <button
      className="arch-network-pill"
      style={{ cursor: "pointer", background: "transparent" }}
      disabled={isPending}
      onClick={() => switchChain({ chainId: arcTestnet.id })}
      title="Switch to Arc"
    >
      {isPending ? "Switching…" : "Switch to Arc"}
    </button>
  );
}

export function WalletButton() {
  const { address, isConnected, chainId } = useAccount();
  const { disconnect } = useDisconnect();
  const { switchChain } = useSwitchChain();
  const [open, setOpen] = useState(false);

  // Auto-switch to Arc whenever a connected wallet is on another chain — the
  // wallet adds the network itself if it's new. Attempt once per wrong-chain
  // state so a user who declines isn't prompt-spammed. The bridge page manages
  // its own chain (Base for burns), so never fight it there.
  const attempted = useRef<number | null>(null);
  useEffect(() => {
    if (!isConnected || chainId === undefined || chainId === arcTestnet.id) return;
    if (typeof window !== "undefined" && window.location.pathname.startsWith("/bridge")) return;
    if (attempted.current === chainId) return;
    attempted.current = chainId;
    switchChain({ chainId: arcTestnet.id });
  }, [isConnected, chainId, switchChain]);

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
