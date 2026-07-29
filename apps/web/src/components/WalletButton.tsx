"use client";

import { useState } from "react";
import { useAccount, useDisconnect } from "wagmi";
import { arcTestnet, baseChain } from "@/lib/bridgeClient";
import { ConnectModal } from "@/components/ConnectModal";

function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function NetworkPill() {
  const { chainId, isConnected } = useAccount();
  if (!isConnected) {
    return <span className="arch-network-pill">Not connected</span>;
  }
  if (chainId === baseChain.id) {
    return (
      <span className="arch-network-pill" style={{ color: "var(--positive)", borderColor: "var(--positive)" }}>
        Base Sepolia
      </span>
    );
  }
  if (chainId === arcTestnet.id) {
    return (
      <span className="arch-network-pill" style={{ color: "var(--positive)", borderColor: "var(--positive)" }}>
        Arc Testnet
      </span>
    );
  }
  return <span className="arch-network-pill">Unsupported network</span>;
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
