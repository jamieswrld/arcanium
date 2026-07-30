"use client";

import { useEffect, useMemo, useState } from "react";
import { usePublicClient } from "wagmi";
import { parseAbiItem, type Hex } from "viem";
import { arcTestnet, ARC_EXPLORER, erc20Abi } from "@/lib/bridgeClient";
import { formatPriceE18, formatUsdCompact, priceUsdE18, poolAbi } from "@/lib/launchpad";
import { formatQuoteUnits } from "@/lib/onchain";
import { CandleChart, type Candle } from "@/components/CandleChart";

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
  readonly creator: Hex;
}

/** Blockdaemon caps eth_getLogs at 100k blocks and 20k results per call, so
 *  history is walked back in chunks. Pool-filtered chunks are tiny, so the
 *  only real stop conditions are genesis or the node's pruning horizon. */
const CHUNK = 45_000n;
const MAX_CHUNKS = 24; // ~1M blocks ≈ days of sub-second Arc blocks — full token history
const POLL_MS = 2_000; // fast: new trades and price land within ~a block or two

const INTERVALS = [
  { key: "1m", sec: 60 },
  { key: "5m", sec: 300 },
  { key: "15m", sec: 900 },
  { key: "1h", sec: 3600 },
] as const;

/** Bucket swap points into OHLC candles; the live spot extends the last bar so
 *  the chart ticks between trades. Floats are display-only. */
function toCandles(swaps: readonly SwapPoint[], spotE18: bigint | null, intervalSec: number): Candle[] {
  const buckets = new Map<number, { o: number; h: number; l: number; c: number; v: number }>();
  const sorted = [...swaps].sort((a, b) => a.timeMs - b.timeMs);
  for (const s of sorted) {
    const t = Math.floor(s.timeMs / 1000 / intervalSec) * intervalSec;
    const p = Number(s.priceE18) / 1e18;
    const v = Number(s.quoteVolume) / 1e6;
    const b = buckets.get(t);
    if (b === undefined) buckets.set(t, { o: p, h: p, l: p, c: p, v });
    else {
      b.h = Math.max(b.h, p);
      b.l = Math.min(b.l, p);
      b.c = p;
      b.v += v;
    }
  }
  // Live tick: extend/append the current bucket with the spot price.
  if (spotE18 !== null) {
    const now = Math.floor(Date.now() / 1000 / intervalSec) * intervalSec;
    const p = Number(spotE18) / 1e18;
    const b = buckets.get(now);
    if (b === undefined) {
      const prevClose = sorted.length > 0 ? Number(sorted[sorted.length - 1]!.priceE18) / 1e18 : p;
      buckets.set(now, { o: prevClose, h: Math.max(prevClose, p), l: Math.min(prevClose, p), c: p, v: 0 });
    } else {
      b.h = Math.max(b.h, p);
      b.l = Math.min(b.l, p);
      b.c = p;
    }
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([time, b]) => ({ time, open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v }));
}

/**
 * Trading terminal panels: TradingView-engine candles (live-ticking), trades
 * feed, holders. One fast initial getLogs, then 2s incremental polling.
 */
export function MarketPanels({ pool, token, pairToken, symbol, creator }: MarketPanelsProps) {
  const arcPublic = usePublicClient({ chainId: arcTestnet.id });
  const [swaps, setSwaps] = useState<SwapPoint[] | null>(null);
  const [spotE18, setSpotE18] = useState<bigint | null>(null);
  const [tab, setTab] = useState<"chart" | "trades" | "holders">("chart");
  const [interval, setIntervalKey] = useState<(typeof INTERVALS)[number]>(INTERVALS[1]);
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

  // Fast initial load (one getLogs) + 2s incremental polling.
  useEffect(() => {
    if (arcPublic === undefined) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cursor = 0n;

    const readSpot = async (): Promise<void> => {
      const slot0 = await arcPublic.readContract({ address: pool, abi: poolAbi, functionName: "slot0" }).catch(() => null);
      if (slot0 !== null && !cancelled) setSpotE18(priceUsdE18(slot0[0], tokenIsToken0));
    };

    const initial = async (): Promise<void> => {
      const tip = await arcPublic.getBlockNumber();
      const nowMs = Date.now();
      await readSpot(); // chart renders immediately, even with zero trades
      cursor = tip;
      timer = setTimeout(() => void poll(), POLL_MS);

      // Full history: walk back from the tip in RPC-sized chunks, streaming
      // results into the chart as each chunk lands (newest first). Stops at
      // genesis or the node's pruning horizon — everything available is shown.
      let end = tip;
      for (let i = 0; i < MAX_CHUNKS && !cancelled; i++) {
        const start = end >= CHUNK ? end - CHUNK + 1n : 0n;
        let logs: unknown[];
        try {
          logs = await arcPublic.getLogs({ address: pool, event: swapEvent, fromBlock: start, toBlock: end });
        } catch {
          break; // pruning horizon — older history requires the indexer
        }
        if (cancelled) return;
        const pts = (logs as RawSwapLog[])
          .map((l) => toPoint(l, nowMs - Number(tip - (l.blockNumber ?? tip)) * 500))
          .filter((p): p is SwapPoint => p !== null);
        if (pts.length > 0) {
          setSwaps((prev) => {
            const merged = [...(prev ?? []), ...pts];
            const seen = new Set<string>();
            return merged
              .filter((p) => {
                const k = `${p.txHash}-${p.block}-${p.priceE18}`;
                if (seen.has(k)) return false;
                seen.add(k);
                return true;
              })
              .sort((a, b) => (a.block < b.block ? -1 : a.block > b.block ? 1 : 0));
          });
        } else if (swaps === null) {
          setSwaps((prev) => prev ?? []);
        }
        if (start === 0n) break;
        end = start - 1n;
      }
      if (!cancelled) setSwaps((prev) => prev ?? []);
    };

    const poll = async (): Promise<void> => {
      try {
        await readSpot();
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
      } catch { /* transient — next tick */ }
      if (!cancelled) timer = setTimeout(() => void poll(), POLL_MS);
    };

    initial().catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; if (timer !== undefined) clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [arcPublic, pool, token, tokenIsToken0]);

  // Holders load lazily on tab open; pool + creator always included via
  // direct balance reads so the tab is never empty.
  useEffect(() => {
    if (arcPublic === undefined || tab !== "holders" || holders !== null) return;
    let cancelled = false;
    (async () => {
      const tip = await arcPublic.getBlockNumber();
      const balances = new Map<string, bigint>();
      // Chunked walk-back over Transfer logs (same RPC limits as swaps).
      let end = tip;
      for (let i = 0; i < MAX_CHUNKS; i++) {
        const start = end >= CHUNK ? end - CHUNK + 1n : 0n;
        let logs;
        try {
          logs = await arcPublic.getLogs({ address: token, event: transferEvent, fromBlock: start, toBlock: end });
        } catch { break; }
        for (const l of logs) {
          const fromA = (l.args.from ?? "0x").toLowerCase();
          const toA = (l.args.to ?? "0x").toLowerCase();
          const v = l.args.value ?? 0n;
          balances.set(fromA, (balances.get(fromA) ?? 0n) - v);
          balances.set(toA, (balances.get(toA) ?? 0n) + v);
        }
        if (start === 0n) break;
        end = start - 1n;
      }
      const [poolBal, creatorBal] = await Promise.all([
        arcPublic.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [pool] }).catch(() => 0n),
        arcPublic.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [creator] }).catch(() => 0n),
      ]);
      balances.set(pool.toLowerCase(), poolBal);
      balances.set(creator.toLowerCase(), creatorBal);
      balances.delete("0x0000000000000000000000000000000000000000");
      const list = [...balances.entries()]
        .filter(([, b]) => b > 0n)
        .sort((a, b) => (b[1] > a[1] ? 1 : -1))
        .slice(0, 20)
        .map(([wallet, balance]) => ({ wallet: wallet as Hex, balance }));
      if (!cancelled) setHolders(list);
    })().catch(() => undefined);
    return () => { cancelled = true; };
  }, [arcPublic, tab, holders, token, pool, creator]);

  const s = swaps ?? [];
  const candles = useMemo(() => toCandles(s, spotE18, interval.sec), [s, spotE18, interval.sec]);

  if (swaps === null && spotE18 === null && !failed) {
    return <div className="arch-skeleton" style={{ height: 380 }} />;
  }

  const volume = s.reduce((acc, x) => acc + x.quoteVolume, 0n);
  const buys = s.filter((x) => x.isBuy).length;
  const first = s[0]?.priceE18;
  const last = spotE18 ?? s[s.length - 1]?.priceE18;
  const changePct = first !== undefined && last !== undefined && first > 0n
    ? Number(((last - first) * 10_000n) / first) / 100
    : null;

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "0.6rem", marginBottom: "0.85rem" }}>
        <div className="arch-pills" style={{ display: "inline-flex" }}>
          <button className={tab === "chart" ? "arch-pill arch-pill-active" : "arch-pill"} style={{ border: "none", cursor: "pointer" }} onClick={() => setTab("chart")}>Chart</button>
          <button className={tab === "trades" ? "arch-pill arch-pill-active" : "arch-pill"} style={{ border: "none", cursor: "pointer" }} onClick={() => setTab("trades")}>Trades</button>
          <button className={tab === "holders" ? "arch-pill arch-pill-active" : "arch-pill"} style={{ border: "none", cursor: "pointer" }} onClick={() => setTab("holders")}>Holders</button>
        </div>
        <span className="arch-note" style={{ fontVariantNumeric: "tabular-nums" }}>
          {changePct !== null ? (
            <span style={{ color: changePct >= 0 ? "var(--positive)" : "var(--negative)", fontWeight: 600, marginRight: "0.5rem" }}>
              {changePct >= 0 ? "+" : ""}{changePct.toFixed(2)}%
            </span>
          ) : null}
          {s.length} trades · <span style={{ color: "var(--positive)" }}>{buys} buys</span> / <span style={{ color: "var(--negative)" }}>{s.length - buys} sells</span> · {formatUsdCompact(volume)} vol
        </span>
      </div>

      {tab === "chart" ? (
        <div>
          <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: "0.4rem" }}>
            <div className="arch-pills" style={{ display: "inline-flex" }}>
              {INTERVALS.map((iv) => (
                <button
                  key={iv.key}
                  className={interval.key === iv.key ? "arch-pill arch-pill-active" : "arch-pill"}
                  style={{ border: "none", cursor: "pointer", padding: "0.25rem 0.7rem", fontSize: "0.75rem" }}
                  onClick={() => setIntervalKey(iv)}
                >
                  {iv.key}
                </button>
              ))}
            </div>
          </div>
          <div style={{ background: "var(--muted)", borderRadius: 14, border: "1px solid var(--border)", padding: "0.5rem" }}>
            <CandleChart candles={candles} />
          </div>
        </div>
      ) : tab === "trades" ? (
        <div className="arch-scroll-x"><TradesTable swaps={s} symbol={symbol} /></div>
      ) : (
        <div className="arch-scroll-x"><HoldersTable holders={holders} pool={pool} symbol={symbol} /></div>
      )}
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
              {h.wallet.slice(0, 6)}…{h.wallet.slice(-4)}{isPool ? <span className="arch-note"> · LP (locked)</span> : null}
            </span>
            <span>{(h.balance / 10n ** 18n).toLocaleString("en-US")} {symbol}</span>
            <span>{(pctBps / 100).toFixed(2)}%</span>
          </a>
        );
      })}
    </div>
  );
}

export { formatPriceE18 };
