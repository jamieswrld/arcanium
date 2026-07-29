"use client";

import { useEffect, useState } from "react";
import { usePublicClient } from "wagmi";
import { parseAbiItem, type Hex } from "viem";
import { arcTestnet, ARC_EXPLORER } from "@/lib/bridgeClient";
import { formatPriceE18, priceUsdE18 } from "@/lib/launchpad";
import { formatQuoteUnits } from "@/lib/onchain";

const transferEvent = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 value)",
);
const swapEvent = parseAbiItem(
  "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)",
);

interface SwapPoint {
  readonly block: bigint;
  readonly timeMs: number;
  readonly priceE18: bigint;
  readonly quoteVolume: bigint;
  readonly isBuy: boolean;
  readonly wallet: Hex;
  readonly tokenAmount: bigint;
  readonly txHash: Hex;
}

interface MarketPanelsProps {
  readonly pool: Hex;
  readonly token: Hex;
  readonly pairToken: Hex;
  readonly symbol: string;
}

/**
 * Chart + trades built from real pool Swap events (bounded recent lookback;
 * the persistent indexer extends history once its VPS lands). Price series
 * uses exact bigint math; pixels are the only place numbers become floats.
 */
export function MarketPanels({ pool, token, pairToken, symbol }: MarketPanelsProps) {
  const arcPublic = usePublicClient({ chainId: arcTestnet.id });
  const [swaps, setSwaps] = useState<SwapPoint[] | null>(null);
  const [tab, setTab] = useState<"chart" | "trades" | "holders">("chart");
  const [holders, setHolders] = useState<Array<{ wallet: Hex; balance: bigint }> | null>(null);
  const [failed, setFailed] = useState(false);

  const tokenIsToken0 = token.toLowerCase() < pairToken.toLowerCase();

  useEffect(() => {
    if (arcPublic === undefined) return;
    let cancelled = false;
    const load = async (): Promise<void> => {
      const tip = await arcPublic.getBlockNumber();
      const lookback = 45_000n;
      const from = tip > lookback ? tip - lookback : 0n;
      const collected: SwapPoint[] = [];
      const tipBlock = await arcPublic.getBlock({ blockNumber: tip });
      const tipTimeMs = Number(tipBlock.timestamp) * 1000;

      for (let start = from; start <= tip && !cancelled; start += 900n) {
        const end = start + 899n < tip ? start + 899n : tip;
        const logs = await arcPublic
          .getLogs({ address: pool, event: swapEvent, fromBlock: start, toBlock: end })
          .catch(() => []);
        for (const l of logs) {
          if (l.transactionHash === null || l.args.sqrtPriceX96 === undefined) continue;
          const amount0 = l.args.amount0 ?? 0n;
          const amount1 = l.args.amount1 ?? 0n;
          const quoteDelta = tokenIsToken0 ? amount1 : amount0;
          const tokenDelta = tokenIsToken0 ? amount0 : amount1;
          collected.push({
            block: l.blockNumber ?? 0n,
            // Sub-second Arc blocks: approximate log time from block delta.
            timeMs: tipTimeMs - Number(tip - (l.blockNumber ?? tip)) * 500,
            priceE18: priceUsdE18(l.args.sqrtPriceX96, tokenIsToken0),
            quoteVolume: quoteDelta < 0n ? -quoteDelta : quoteDelta,
            isBuy: quoteDelta > 0n,
            wallet: (l.args.recipient ?? "0x") as Hex,
            tokenAmount: tokenDelta < 0n ? -tokenDelta : tokenDelta,
            txHash: l.transactionHash,
          });
        }
        await new Promise((r) => setTimeout(r, 150));
      }
      if (!cancelled) setSwaps(collected);
      // Best-effort holders from the same bounded window (complete for young tokens).
      const balances = new Map();
      for (let start = from; start <= tip && !cancelled; start += 900n) {
        const end = start + 899n < tip ? start + 899n : tip;
        const logs = await arcPublic
          .getLogs({ address: token, event: transferEvent, fromBlock: start, toBlock: end })
          .catch(() => []);
        for (const l of logs) {
          const fromA = (l.args.from ?? "0x").toLowerCase();
          const toA = (l.args.to ?? "0x").toLowerCase();
          const v = l.args.value ?? 0n;
          balances.set(fromA, (balances.get(fromA) ?? 0n) - v);
          balances.set(toA, (balances.get(toA) ?? 0n) + v);
        }
        await new Promise((r) => setTimeout(r, 150));
      }
      balances.delete("0x0000000000000000000000000000000000000000");
      const list = [...balances.entries()]
        .filter(([, b]) => b > 0n)
        .sort((a, b) => (b[1] > a[1] ? 1 : -1))
        .slice(0, 20)
        .map(([wallet, balance]) => ({ wallet, balance }));
      if (!cancelled) setHolders(list);
    };
    load().catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [arcPublic, pool, token, tokenIsToken0]);

  if (failed) return <p className="arch-note">Couldn&apos;t load market data from the RPC just now.</p>;
  if (swaps === null) return <p className="arch-note">Reading swaps from the pool…</p>;

  const volume = swaps.reduce((acc, s) => acc + s.quoteVolume, 0n);
  const buys = swaps.filter((s) => s.isBuy).length;

  return (
    <div>
      <div className="arch-pills" style={{ display: "inline-flex", marginBottom: "0.75rem" }}>
        <button className={tab === "chart" ? "arch-pill arch-pill-active" : "arch-pill"} style={{ border: "none", cursor: "pointer" }} onClick={() => setTab("chart")}>
          Chart
        </button>
        <button className={tab === "trades" ? "arch-pill arch-pill-active" : "arch-pill"} style={{ border: "none", cursor: "pointer" }} onClick={() => setTab("trades")}>
          Trades
        </button>
        <button className={tab === "holders" ? "arch-pill arch-pill-active" : "arch-pill"} style={{ border: "none", cursor: "pointer" }} onClick={() => setTab("holders")}>
          Holders
        </button>
        <span className="arch-note" style={{ alignSelf: "center", padding: "0 0.5rem" }}>
          {swaps.length} recent trades · {buys} buys / {swaps.length - buys} sells · $
          {formatQuoteUnits(volume)} volume
        </span>
      </div>

      {tab === "chart" ? (
        <PriceSvg swaps={swaps} />
      ) : tab === "trades" ? (
        <TradesTable swaps={swaps} symbol={symbol} />
      ) : (
        <HoldersTable holders={holders} pool={pool} symbol={symbol} />
      )}
    </div>
  );
}

function PriceSvg({ swaps }: { readonly swaps: SwapPoint[] }) {
  if (swaps.length === 0) {
    return <p className="arch-note">No trades in the recent window yet — the chart begins with the first swap.</p>;
  }
  const W = 640;
  const H = 220;
  const PAD = 8;
  let min = swaps[0]?.priceE18 ?? 0n;
  let max = min;
  for (const s of swaps) {
    if (s.priceE18 < min) min = s.priceE18;
    if (s.priceE18 > max) max = s.priceE18;
  }
  if (max === min) max = min + 1n;
  const span = max - min;
  const points = swaps.map((s, i) => {
    const x = PAD + (i * (W - 2 * PAD)) / Math.max(1, swaps.length - 1);
    // Display-only float conversion of a bounded ratio (never money math).
    const ratio = Number(((s.priceE18 - min) * 10_000n) / span) / 10_000;
    const y = H - PAD - ratio * (H - 2 * PAD);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  return (
    <div style={{ overflowX: "auto" }}>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", minWidth: 320 }} role="img" aria-label="Price chart">
        <polyline points={points.join(" ")} fill="none" stroke="var(--arch-primary)" strokeWidth="2" />
      </svg>
      <div style={{ display: "flex", justifyContent: "space-between" }} className="arch-note">
        <span>low {formatPriceE18(min)}</span>
        <span>high {formatPriceE18(max)}</span>
      </div>
    </div>
  );
}

function TradesTable({ swaps, symbol }: { readonly swaps: SwapPoint[]; readonly symbol: string }) {
  const rows = [...swaps].reverse().slice(0, 25);
  if (rows.length === 0) return <p className="arch-note">No trades yet.</p>;
  return (
    <div style={{ display: "grid", gap: "0.25rem" }}>
      <div style={{ display: "grid", gridTemplateColumns: "56px 1fr 110px 90px", gap: "0.5rem" }} className="arch-note">
        <span>Type</span><span>Wallet</span><span>Amount</span><span>Value</span>
      </div>
      {rows.map((s) => (
        <a
          key={`${s.txHash}-${s.block}`}
          href={`${ARC_EXPLORER}/tx/${s.txHash}`}
          target="_blank"
          rel="noreferrer"
          style={{ display: "grid", gridTemplateColumns: "56px 1fr 110px 90px", gap: "0.5rem", fontSize: "0.85rem", padding: "0.25rem 0", borderBottom: "1px solid var(--arch-border)" }}
        >
          <span style={{ color: s.isBuy ? "var(--arch-positive)" : "var(--arch-negative)", fontWeight: 600 }}>
            {s.isBuy ? "Buy" : "Sell"}
          </span>
          <span style={{ fontFamily: "monospace" }}>{s.wallet.slice(0, 6)}…{s.wallet.slice(-4)}</span>
          <span>{(s.tokenAmount / 10n ** 18n).toLocaleString("en-US")} {symbol}</span>
          <span>${formatQuoteUnits(s.quoteVolume)}</span>
        </a>
      ))}
    </div>
  );
}

function HoldersTable({ holders, pool, symbol }: { readonly holders: Array<{ wallet: Hex; balance: bigint }> | null; readonly pool: Hex; readonly symbol: string }) {
  if (holders === null) return <p className="arch-note">Reading holders…</p>;
  if (holders.length === 0) return <p className="arch-note">No holders found in the recent window.</p>;
  const SUPPLY = 1_000_000_000n * 10n ** 18n;
  return (
    <div style={{ display: "grid", gap: "0.25rem" }}>
      <div style={{ display: "grid", gridTemplateColumns: "32px 1fr 140px 70px", gap: "0.5rem" }} className="arch-note">
        <span>#</span><span>Wallet</span><span>Amount</span><span>Supply</span>
      </div>
      {holders.map((h, i) => {
        const isPool = h.wallet.toLowerCase() === pool.toLowerCase();
        const pctBps = Number((h.balance * 10_000n) / SUPPLY);
        return (
          <a key={h.wallet} href={`${ARC_EXPLORER}/address/${h.wallet}`} target="_blank" rel="noreferrer"
            style={{ display: "grid", gridTemplateColumns: "32px 1fr 140px 70px", gap: "0.5rem", fontSize: "0.85rem", padding: "0.25rem 0", borderBottom: "1px solid var(--arch-border)" }}>
            <span className="arch-note">{i + 1}</span>
            <span style={{ fontFamily: "monospace" }}>
              {h.wallet.slice(0, 6)}…{h.wallet.slice(-4)}{isPool ? <span className="arch-note"> · LP</span> : null}
            </span>
            <span>{(h.balance / 10n ** 18n).toLocaleString("en-US")} {symbol}</span>
            <span>{(pctBps / 100).toFixed(2)}%</span>
          </a>
        );
      })}
      <p className="arch-note" style={{ margin: "0.5rem 0 0" }}>
        Best-effort view from recent transfers; the full-history indexer extends this.
      </p>
    </div>
  );
}
