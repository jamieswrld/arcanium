"use client";

import { useAccount, useSwitchChain } from "wagmi";
import { arcTestnet } from "@/lib/bridgeClient";

/**
 * Network state, told honestly.
 *
 * Arcanium runs on Arc and nowhere else, so this is not a chain picker — it is
 * a status light with a repair action. It distinguishes the states a user can
 * actually be in, because "wrong network" and "connected" failing the same way
 * is how people end up staring at a wallet error they cannot interpret:
 *
 *   not connected  — neutral, purely informational
 *   on Arc         — green, no action
 *   wrong network  — amber and clickable, switches to Arc
 *   switching      — in progress, disabled
 *
 * Base is intentionally not treated as "wrong" in a blocking sense elsewhere in
 * the app: the bridge legitimately operates there. This badge reflects the
 * launch/trade surface, which is Arc.
 */
export function NetworkBadge() {
  const { isConnected, chainId } = useAccount();
  const { switchChain, isPending } = useSwitchChain();

  const onArc = chainId === arcTestnet.id;

  if (isPending) {
    return (
      <span className="chip" title="Switching network">
        <Dot color="var(--warning)" pulse />
        Switching…
      </span>
    );
  }

  if (!isConnected) {
    return (
      <span className="chip" title="Arcanium launches and trades on Arc (chain 5042)">
        <Dot color="var(--text-muted)" />
        Arc
      </span>
    );
  }

  if (!onArc) {
    return (
      <button
        type="button"
        className="chip"
        onClick={() => switchChain({ chainId: arcTestnet.id })}
        title="Your wallet is on another network. Click to switch to Arc."
        style={{
          cursor: "pointer",
          borderColor: "color-mix(in oklch, var(--warning) 45%, transparent)",
          color: "var(--warning)",
          background: "var(--warning-quiet)",
        }}
      >
        <Dot color="var(--warning)" />
        Wrong network
      </button>
    );
  }

  return (
    <span className="chip chip-pos" title="Connected to Arc (chain 5042)">
      <Dot color="var(--positive)" />
      Arc
    </span>
  );
}

function Dot({ color, pulse = false }: { readonly color: string; readonly pulse?: boolean }) {
  return (
    <span
      aria-hidden
      style={{
        width: 6,
        height: 6,
        borderRadius: 999,
        background: color,
        flexShrink: 0,
        ...(pulse ? { animation: "shimmer 1.2s ease-in-out infinite alternate" } : {}),
      }}
    />
  );
}
