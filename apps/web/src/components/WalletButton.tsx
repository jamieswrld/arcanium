"use client";

import { useEffect, useRef, useState } from "react";
import { useAccount, useBalance, useDisconnect, useSwitchChain } from "wagmi";
import { arcTestnet } from "@/lib/bridgeClient";
import { getChain, explorerAddress } from "@/lib/chains";
import { ConnectModal } from "@/components/ConnectModal";

/**
 * Wallet control.
 *
 * Connected state opens a menu rather than disconnecting on click. The previous
 * button called disconnect() directly, so a single stray click dropped the
 * session — on a trading surface that is a hostile default, and it made the
 * address impossible to copy without leaving.
 *
 * The menu carries the things people actually want from a wallet chip: the full
 * address, a copy action, the explorer, the gas balance, and disconnect placed
 * last and marked destructive.
 */

function short(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/** A deterministic two-colour mark derived from the address. Cheap identity
 *  cue, no network request, and stable across sessions. */
function addressHue(address: string): number {
  let h = 0;
  for (let i = 2; i < address.length; i += 1) h = (h * 31 + address.charCodeAt(i)) % 360;
  return h;
}

export function WalletButton() {
  const { address, isConnected, chainId } = useAccount();
  const { disconnect } = useDisconnect();
  const { switchChain } = useSwitchChain();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const chain = getChain("arc");

  const balance = useBalance({
    address,
    chainId: arcTestnet.id,
    query: { enabled: address !== undefined, refetchInterval: 20_000 },
  });

  // Auto-switch to Arc when a connected wallet sits on another chain. Attempted
  // once per wrong-chain state so declining does not spam prompts, and never on
  // the bridge, which legitimately operates on Base.
  const attempted = useRef<number | null>(null);
  useEffect(() => {
    if (!isConnected || chainId === undefined || chainId === arcTestnet.id) return;
    if (typeof window !== "undefined" && window.location.pathname.startsWith("/bridge")) return;
    if (attempted.current === chainId) return;
    attempted.current = chainId;
    switchChain({ chainId: arcTestnet.id });
  }, [isConnected, chainId, switchChain]);

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent): void => {
      if (wrap.current !== null && !wrap.current.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  async function copyAddress(): Promise<void> {
    if (address === undefined) return;
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      /* clipboard blocked — the address is shown in full above the button */
    }
  }

  if (!isConnected || address === undefined) {
    return (
      <>
        <button type="button" className="btn btn-primary wallet-connect" onClick={() => setPickerOpen(true)}>
          <span className="wallet-connect-label">Connect wallet</span>
        </button>
        <ConnectModal open={pickerOpen} onClose={() => setPickerOpen(false)} />
      </>
    );
  }

  const hue = addressHue(address);

  return (
    <div ref={wrap} style={{ position: "relative" }}>
      <button
        type="button"
        className="wallet-chip"
        onClick={() => setMenuOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        title={address}
      >
        <span
          aria-hidden
          className="wallet-avatar"
          style={{
            background: `linear-gradient(135deg, hsl(${hue} 62% 52%), hsl(${(hue + 48) % 360} 62% 38%))`,
          }}
        />
        <span className="mono wallet-addr">{short(address)}</span>
        <svg width="9" height="9" viewBox="0 0 12 12" fill="none" aria-hidden>
          <path d="M2.5 4.5 6 8l3.5-3.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {menuOpen ? (
        <div className="wallet-menu" role="menu">
          <div className="wallet-menu-head">
            <span
              aria-hidden
              className="wallet-avatar"
              style={{
                width: 30,
                height: 30,
                background: `linear-gradient(135deg, hsl(${hue} 62% 52%), hsl(${(hue + 48) % 360} 62% 38%))`,
              }}
            />
            <span style={{ minWidth: 0 }}>
              <span className="mono" style={{ display: "block", fontSize: "0.78rem" }}>
                {short(address)}
              </span>
              <span className="num" style={{ display: "block", fontSize: "0.72rem", color: "var(--text-muted)" }}>
                {balance.data !== undefined
                  ? `${Number(balance.data.formatted).toFixed(4)} ${balance.data.symbol}`
                  : "—"}
              </span>
            </span>
          </div>

          <button type="button" role="menuitem" className="wallet-menu-item" onClick={() => void copyAddress()}>
            <CopyIcon />
            {copied ? "Copied" : "Copy address"}
          </button>

          <a
            role="menuitem"
            className="wallet-menu-item"
            href={explorerAddress(chain, address)}
            target="_blank"
            rel="noreferrer"
            onClick={() => setMenuOpen(false)}
          >
            <ExternalIcon />
            View on explorer
          </a>

          <button
            type="button"
            role="menuitem"
            className="wallet-menu-item wallet-menu-danger"
            onClick={() => {
              setMenuOpen(false);
              disconnect();
            }}
          >
            <PowerIcon />
            Disconnect
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** Kept for callers that still import it; network state lives in NetworkBadge. */
export function NetworkPill() {
  const { chainId, isConnected } = useAccount();
  const { switchChain, isPending } = useSwitchChain();
  if (!isConnected) return <span className="chip">Not connected</span>;
  if (chainId === arcTestnet.id) return <span className="chip chip-pos">Arc</span>;
  return (
    <button
      type="button"
      className="chip"
      style={{ cursor: "pointer", color: "var(--warning)" }}
      disabled={isPending}
      onClick={() => switchChain({ chainId: arcTestnet.id })}
    >
      {isPending ? "Switching…" : "Switch to Arc"}
    </button>
  );
}

const I = {
  width: 14,
  height: 14,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.7,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true as const,
};

function CopyIcon() {
  return (
    <svg {...I}>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V5h10" />
    </svg>
  );
}
function ExternalIcon() {
  return (
    <svg {...I}>
      <path d="M14 4h6v6" />
      <path d="M20 4 11 13" />
      <path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
    </svg>
  );
}
function PowerIcon() {
  return (
    <svg {...I}>
      <path d="M12 4v8" />
      <path d="M7.5 7a7 7 0 1 0 9 0" />
    </svg>
  );
}
