"use client";

import { useAccount, useBalance, useReadContract } from "wagmi";
import { arcTestnet, AUSD_ADDRESS, baseChain, erc20Abi, formatQuoteUnits, USDC_ADDRESS } from "@/lib/bridgeClient";
import { ConnectButton } from "@/components/ConnectButton";
import { NetworkNotice } from "@/components/NetworkNotice";

/** 18-decimal native → short USDC string. */
function fmtNative(wei: bigint): string {
  const micro = wei / 10n ** 12n;
  return formatQuoteUnits(micro);
}

interface Row {
  readonly asset: string;
  readonly chain: string;
  readonly amount: string;
  readonly usd: number;
  readonly pending: boolean;
}

/**
 * Live portfolio: reads the connected wallet's USDC on Base, aUSD and native
 * gas on Arc. Treats aUSD and USDC as $1 (aUSD is 1:1 USDC-backed).
 */
export function Portfolio() {
  const { address, isConnected } = useAccount();

  const usdc = useReadContract({
    address: USDC_ADDRESS,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: address === undefined ? undefined : [address],
    chainId: baseChain.id,
    query: { enabled: address !== undefined, refetchInterval: 15_000 },
  });
  const ausd = useReadContract({
    address: AUSD_ADDRESS,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: address === undefined ? undefined : [address],
    chainId: arcTestnet.id,
    query: { enabled: address !== undefined && AUSD_ADDRESS !== undefined, refetchInterval: 15_000 },
  });
  const arcGas = useBalance({
    address,
    chainId: arcTestnet.id,
    query: { enabled: address !== undefined, refetchInterval: 15_000 },
  });

  if (!isConnected || address === undefined) {
    return (
      <div className="arch-stack">
        <Card>
          <p className="arch-note" style={{ margin: 0 }}>
            Connect your wallet to see your USDC, aUSD, and Arc gas across both chains.
          </p>
          <div style={{ marginTop: "0.75rem", maxWidth: 240 }}>
            <ConnectButton />
          </div>
        </Card>
      </div>
    );
  }

  // Always show every asset row — 0.00 when empty, "…" while a read is in
  // flight — so a slow or failed RPC never makes a balance silently vanish.
  const rows: Row[] = [
    { asset: "USDC", chain: "Base", amount: usdc.data !== undefined ? formatQuoteUnits(usdc.data) : (usdc.isLoading ? "…" : "0"), usd: usdc.data !== undefined ? Number(usdc.data) / 1e6 : 0, pending: usdc.data === undefined && usdc.isLoading },
    { asset: "aUSD", chain: "Arc", amount: ausd.data !== undefined ? formatQuoteUnits(ausd.data) : (ausd.isLoading ? "…" : "0"), usd: ausd.data !== undefined ? Number(ausd.data) / 1e6 : 0, pending: ausd.data === undefined && ausd.isLoading },
    { asset: "USDC (gas)", chain: "Arc", amount: arcGas.data !== undefined ? fmtNative(arcGas.data.value) : (arcGas.isLoading ? "…" : "0"), usd: arcGas.data !== undefined ? Number(arcGas.data.value) / 1e18 : 0, pending: arcGas.data === undefined && arcGas.isLoading },
  ];

  const total = rows.reduce((a, r) => a + r.usd, 0);
  const loading = usdc.isLoading || ausd.isLoading || arcGas.isLoading;

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
              ${total.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </div>
          </div>
        </div>
      </Card>

      <section>
        <div className="arch-section-head"><h2>Positions</h2></div>
        <Card>
          <div className="arch-token-list-head" style={{ gridTemplateColumns: "1fr 140px 120px" }}>
            <span>Asset</span><span>Amount</span><span>Value</span>
          </div>
          {rows.length === 0 ? (
            <p className="arch-note" style={{ margin: "1rem 0 0", textAlign: "center" }}>
              {loading ? "Reading balances…" : "No balances yet — bridge some USDC to get started."}
            </p>
          ) : (
            <div style={{ display: "grid", gap: "0.25rem", marginTop: "0.5rem" }}>
              {rows.map((r) => (
                <div key={r.asset + r.chain} style={{ display: "grid", gridTemplateColumns: "1fr 140px 120px", gap: "0.75rem", padding: "0.6rem 0", borderBottom: "1px solid var(--border)", alignItems: "center" }}>
                  <span><strong>{r.asset}</strong> <span className="arch-note">on {r.chain}</span></span>
                  <span>{r.amount}</span>
                  <span>${r.usd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                </div>
              ))}
            </div>
          )}
        </Card>
      </section>
    </div>
  );
}

// Local Card to avoid a client/server boundary import surprise.
function Card({ children }: { readonly children: React.ReactNode }) {
  return <section className="arch-card">{children}</section>;
}
