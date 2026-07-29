"use client";

import { useAccount, useConnect, useDisconnect } from "wagmi";
import { arcTestnet, baseChain } from "@/lib/bridgeClient";

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
      <span className="arch-network-pill" style={{ color: "var(--arch-positive)", borderColor: "var(--arch-positive)" }}>
        Base Sepolia
      </span>
    );
  }
  if (chainId === arcTestnet.id) {
    return (
      <span className="arch-network-pill" style={{ color: "var(--arch-positive)", borderColor: "var(--arch-positive)" }}>
        Arc Testnet
      </span>
    );
  }
  return <span className="arch-network-pill">Unsupported network</span>;
}

export function WalletButton() {
  const { address, isConnected } = useAccount();
  const { connectors, connect, isPending } = useConnect();
  const { disconnect } = useDisconnect();

  if (isConnected && address !== undefined) {
    return (
      <button
        className="arch-wallet-button"
        style={{ cursor: "pointer", opacity: 1 }}
        onClick={() => disconnect()}
        title="Disconnect"
      >
        {shortAddress(address)}
      </button>
    );
  }

  const connector = connectors[0];
  return (
    <button
      className="arch-wallet-button"
      style={{ cursor: connector === undefined ? "not-allowed" : "pointer", opacity: connector === undefined ? 0.7 : 1 }}
      disabled={connector === undefined || isPending}
      onClick={() => {
        if (connector !== undefined) connect({ connector });
      }}
      title={connector === undefined ? "No browser wallet detected — install MetaMask, Rabby, Coinbase Wallet, or Rainbow" : "Connect wallet"}
    >
      {isPending ? "Connecting…" : "Connect wallet"}
    </button>
  );
}
