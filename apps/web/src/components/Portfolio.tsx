"use client";

import { useAccount, useBalance } from "wagmi";
import { arcTestnet, formatQuoteUnits } from "@/lib/bridgeClient";
import { ConnectButton } from "@/components/ConnectButton";
import { NetworkNotice } from "@/components/NetworkNotice";

/** 18-decimal native → short USDC string. */
function fmtNative(wei: bigint): string {
  return formatQuoteUnits(wei / 10n ** 12n);
}

/**
 * Live portfolio: the connected wallet's USDC on Arc. On Arc, USDC is the
 * native token — the single balance that pays gas, launches, and trades.
 */
export function Portfolio() {
  const { address, isConnected } = useAccount();

  const arcUsdc = useBalance({
    address,
    chainId: arcTestnet.id,
    query: { enabled: address !== undefined, refetchInterval: 15_000 },
  });

  if (!isConnected || address === undefined) {
    return (
      <div className="arch-stack">
        <Card>
          <p className="arch-note" style={{ margin: 0 }}>
            Connect your wallet to see your USDC on Arc.
          </p>
          <div style={{ marginTop: "0.75rem", maxWidth: 240 }}>
            <ConnectButton />
          </div>
        </Card>
      </div>
    );
  }

  const amount = arcUsdc.data !== undefined ? fmtNative(arcUsdc.data.value) : arcUsdc.isLoading ? "…" : "0";
  const usd = arcUsdc.data !== undefined ? Number(arcUsdc.data.value) / 1e18 : 0;

  return (
    <div className="arch-stack">
      <NetworkNotice />
      <Card>
        <div style={{ display: "flex", alignItems: "center", gap: "1rem" }}>
          <div aria-hidden style={{ width: 56, height: 56, borderRadius: 14, background: "var(--arch-primary)", display: "grid", placeItems: "center", color: "#fff", fontWeight: 700, fontFamily: "monospace" }}>
            {address.slice(2, 4).toUpperCase()}
          </div>
          <div>
            <div className="arch-note" style={{ fontFamily: "monospace" }}>{address.slice(0, 6)}…{address.slice(-4)}</div>
            <div style={{ fontSize: "1.75rem", fontWeight: 700 }}>
              ${usd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </div>
          </div>
        </div>
      </Card>

      <section>
        <div className="arch-section-head"><h2>Balances</h2></div>
        <Card>
          <div className="arch-token-list-head" style={{ gridTemplateColumns: "1fr 140px 120px" }}>
            <span>Asset</span><span>Amount</span><span>Value</span>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 140px 120px", gap: "0.75rem", padding: "0.6rem 0", alignItems: "center" }}>
            <span><strong>USDC</strong> <span className="arch-note">on Arc</span></span>
            <span>{amount}</span>
            <span>${usd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
          </div>
          {arcUsdc.data !== undefined && arcUsdc.data.value === 0n ? (
            <p className="arch-note" style={{ margin: "0.5rem 0 0" }}>
              No USDC on Arc yet — add some to your wallet to launch and trade.
            </p>
          ) : null}
        </Card>
      </section>
    </div>
  );
}

// Local Card to avoid a client/server boundary import surprise.
function Card({ children }: { readonly children: React.ReactNode }) {
  return <section className="arch-card">{children}</section>;
}
