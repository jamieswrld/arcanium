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

interface RawSwapLog {
  readonly transactionHash: Hex | null;
  readonly blockNumber: bigint | null;
  readonly args: { sqrtPriceX96?: bigint; amount0?: bigint; amount1?: bigint; recipient?: string };
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
const LOOKBACK = 200_000n; // one wide getLogs; Arc's sub-second blocks make this ~a day

export function MarketPanels({ pool, token, pairToken, symbol }: MarketPanelsProps) {
  const arcPublic = usePublicClient({ chainId: arcTestnet.id });
  const [swaps, setSwaps] = useState<SwapPoint[] | null>(null);
  const [tab, setTab] = useState<"chart" | "trades" | "holders">("chart");
  const [holders, setHolders] = useState<Array<{ wallet: Hex; balance: bigint }> | null>(null);
  const [failed, setFailed] = useState(false);

  const tokenIsToken0 = token.toLowerCase() < pairToken.toLowerCase();

  const toPoint = (l: RawSwapLog, timeMs: number): SwapPoint | null => {
    if (l.transactionHash === null || l.args.sqrtPriceX96 === undefined) return null;
    const amount0 = l.args.amount0 ?? 0n;
    const amount1 = l.args.amount1 ?? 0n;
    const quoteDelta = tokenIsToken0 ? amount1 : amount0;
    const tokenDelta = tokenIsToken0 ? amount0 : amount1;
    return {
      block: l.blockNumber ?? 0n,
      timeMs,
      priceE18: priceUsdE18(l.args.sqrtPriceX96, tokenIsToken0),
      quoteVolume: quoteDelta < 0n ? -quoteDelta : quoteDelta,
      isBuy: quoteDelta > 0n,
      wallet: (l.args.recipient ?? "0x") as Hex,
      tokenAmount: tokenDelta < 0n ? -tokenDelta : tokenDelta,
      txHash: l.transactionHash,
    };
  };

  // Fast initial load (one getLogs) + light incremental polling so the chart
  // and trades keep up in near-real-time without re-scanning history.
  useEffect(() => {
    if (arcPublic === undefined) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cursor = 0n;

    const initial = async (): Promise<void> => {
      const tip = await arcPublic.getBlockNumber();
      const from = tip > LOOKBACK ? tip - LOOKBACK : 0n;
      const nowMs = Date.now();
      const logs = await arcPublic.getLogs({ address: pool, event: swapEvent, fromBlock: from, toBlock: tip }).catch(() => []);
      if (cancelled) return;
      const pts = logs
        .map((l) => toPoint(l as unknown as RawSwapLog, nowMs - Number(tip - (l.blockNumber ?? tip)) * 500))
        .filter((p): p is SwapPoint => p !== null);
      setSwaps(pts);
      cursor = tip;
      timer = setTimeout(() => void poll(), 4_000);
    };

    const poll = async (): Promise<void> => {
      try {
        const tip = await arcPublic.getBlockNumber();
        if (tip > cursor) {
          const logs = await arcPublic.getLogs({ address: pool, event: swapEvent, fromBlock: cursor + 1n, toBlock: tip }).catch(() => []);
          if (!cancelled && logs.length > 0) {
            const nowMs = Date.now();
            const pts = logs.map((l) => toPoint(l as unknown as RawSwapLog, nowMs)).filter((p): p is SwapPoint => p !== null);
            if (pts.length > 0) setSwaps((prev) => [...(prev ?? []), ...pts]);
          }
          cursor = tip;
        }
      } catch { /* transient — try again next tick */ }
      if (!cancelled) timer = setTimeout(() => void poll(), 4_000);
    };

    initial().catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; if (timer !== undefined) clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [arcPublic, pool, token, tokenIsToken0]);

  // Holders load lazily — only when the tab is opened, and only once.
  useEffect(() => {
    if (arcPublic === undefined || tab !== "holders" || holders !== null) return;
    let cancelled = false;
    (async () => {
      const tip = await arcPublic.getBlockNumber();
      const from = tip > LOOKBACK ? tip - LOOKBACK : 0n;
      const logs = await arcPublic.getLogs({ address: token, event: transferEvent, fromBlock: from, toBlock: tip }).catch(() => []);
      const balances = new Map<string, bigint>();
      for (const l of logs) {
        const fromA = (l.args.from ?? "0x").toLowerCase();
        const toA = (l.args.to ?? "0x").toLowerCase();
        const v = l.args.value ?? 0n;
        balances.set(fromA, (balances.get(fromA) ?? 0n) - v);
        balances.set(toA, (balances.get(toA) ?? 0n) + v);
      }
      balances.delete("0x0000000000000000000000000000000000000000");
      const list = [...balances.entries()]
        .filter(([, b]) => b > 0n)
        .sort((a, b) => (b[1] > a[1] ? 1 : -1))
        .slice(0, 20)
        .map(([wallet, balance]) => ({ wallet: wallet as Hex, balance }));
      if (!cancelled) setHolders(list);
    })().catch(() => undefined);
    return () => { cancelled = true; };
  }, [arcPublic, tab, holders, token]);

  if (failed) return <p className="arch-note">Couldn&apos;t load market data from the RPC just now.</p>;
  if (swaps === null) return <p className="arch-note">Reading swaps from the pool…</p>;

  const volume = swaps.reduce((acc, s) => acc + s.quoteVolume, 0n);
  const buys = swaps.filter((s) => s.isBuy).length;

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "0.6rem", marginBottom: "0.85rem" }}>
        <div className="arch-pills" style={{ display: "inline-flex" }}>
          <button className={tab === "chart" ? "arch-pill arch-pill-active" : "arch-pill"} style={{ border: "none", cursor: "pointer" }} onClick={() => setTab("chart")}>Chart</button>
          <button className={tab === "trades" ? "arch-pill arch-pill-active" : "arch-pill"} style={{ border: "none", cursor: "pointer" }} onClick={() => setTab("trades")}>Trades</button>
          <button className={tab === "holders" ? "arch-pill arch-pill-active" : "arch-pill"} style={{ border: "none", cursor: "pointer" }} onClick={() => setTab("holders")}>Holders</button>
        </div>
        <span className="arch-note" style={{ fontVariantNumeric: "tabular-nums" }}>
          {swaps.length} trades · <span style={{ color: "var(--positive)" }}>{buys} buys</span> / <span style={{ color: "var(--negative)" }}>{swaps.length - buys} sells</span> · ${formatQuoteUnits(volume)} vol
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
    return (
      <div style={{ height: 220, display: "grid", placeItems: "center", background: "var(--muted)", borderRadius: 14, border: "1px solid var(--border)" }}>
        <p className="arch-note" style={{ margin: 0, textAlign: "center", maxWidth: 320 }}>No trades yet — the chart begins with the first swap.</p>
      </div>
    );
  }
  const W = 640;
  const H = 220;
  const PAD = 14;
  let min = swaps[0]?.priceE18 ?? 0n;
  let max = min;
  for (const s of swaps) {
    if (s.priceE18 < min) min = s.priceE18;
    if (s.priceE18 > max) max = s.priceE18;
  }
  if (max === min) max = min + 1n;
  const span = max - min;
  const n = swaps.length;
  const xy = swaps.map((s, i) => {
    const x = PAD + (i * (W - 2 * PAD)) / Math.max(1, n - 1);
    // Display-only float conversion of a bounded ratio (never money math).
    const ratio = Number(((s.priceE18 - min) * 10_000n) / span) / 10_000;
    const y = H - PAD - ratio * (H - 2 * PAD);
    return { x, y };
  });
  // A single trade renders as a flat baseline across the width.
  const pts = n === 1 ? [{ x: PAD, y: xy[0]!.y }, { x: W - PAD, y: xy[0]!.y }] : xy;
  const line = pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
  const area = `${PAD},${H - PAD} ${line} ${(W - PAD).toFixed(1)},${H - PAD}`;
  const up = (swaps[n - 1]?.priceE18 ?? 0n) >= (swaps[0]?.priceE18 ?? 0n);
  const stroke = up ? "var(--positive)" : "var(--negative)";

  return (
    <div>
      <div style={{ overflowX: "auto", background: "var(--muted)", borderRadius: 14, border: "1px solid var(--border)", padding: "0.5rem" }}>
        <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", minWidth: 320, display: "block" }} role="img" aria-label="Price chart" preserveAspectRatio="none">
          <defs>
            <linearGradient id="arch-price-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={stroke} stopOpacity="0.28" />
              <stop offset="100%" stopColor={stroke} stopOpacity="0" />
            </linearGradient>
          </defs>
          {[0.25, 0.5, 0.75].map((g) => (
            <line key={g} x1={PAD} x2={W - PAD} y1={PAD + g * (H - 2 * PAD)} y2={PAD + g * (H - 2 * PAD)} stroke="var(--border)" strokeWidth="1" strokeDasharray="3 5" opacity="0.6" />
          ))}
          <polygon points={area} fill="url(#arch-price-fill)" />
          <polyline points={line} fill="none" stroke={stroke} strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />
          <circle cx={pts[pts.length - 1]!.x} cy={pts[pts.length - 1]!.y} r="4" fill={stroke} />
        </svg>
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: "0.4rem" }} className="arch-note">
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
