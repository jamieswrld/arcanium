"use client";

import { useEffect, useMemo, useState } from "react";
import { usePublicClient } from "wagmi";
import { parseAbiItem, type Hex } from "viem";
import { formatUnits } from "viem";
import { erc20Abi } from "@/lib/bridgeClient";
import { explorerAddress, explorerTx, getChain, type ChainKey, type LaunchChain } from "@/lib/chains";
import { formatPriceE18, formatUsdCompact, priceUsdE18, poolAbi } from "@/lib/launchpad";
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
  /** Chain the token was launched on. */
  readonly chainKey?: ChainKey;
}

/**
 * Arc rejects any getLogs range much above 10,000 blocks — measured: 9,000
 * succeeds, 45,000 is refused outright.
 *
 * This was 45,000, sized for Blockdaemon's 100k cap, which meant the very first
 * request of every walk below threw and the loop broke immediately. Neither the
 * chart's history nor the holders list ever loaded a single log from it.
 *
 * These walks are now only a fallback for when the indexer is unavailable, so
 * the chunk count buys depth rather than speed: 40 x 9,000 is ~360k blocks,
 * about two days of Arc. Full history comes from the indexer.
 */
const CHUNK = 9_000n;
const MAX_CHUNKS = 40;
const POLL_MS = 2_000; // fast: new trades and price land within ~a block or two

/**
 * Chart timeframes.
 *
 * Every `sec` here is an interval the indexer actually buckets, so each one can
 * be served from stored candles instead of re-derived in the browser. 6h is
 * absent because the candles table constrains interval_seconds to a fixed set
 * and 21600 is not in it; 4h covers the same ground without a migration.
 *
 * "All" has no fixed bucket. It picks the coarsest interval that still shows
 * the token's whole life in a readable number of bars, which is the view that
 * actually answers "what has this thing done since launch".
 */
const INTERVALS = [
  { key: "1m", sec: 60 },
  { key: "5m", sec: 300 },
  { key: "15m", sec: 900 },
  { key: "1h", sec: 3600 },
  { key: "4h", sec: 14_400 },
  { key: "1D", sec: 86_400 },
  { key: "All", sec: 0 },
] as const;

/** Interval keys the market route accepts, by bucket length. */
const INTERVAL_PARAM: Record<number, string> = {
  60: "1m",
  300: "5m",
  900: "15m",
  3600: "1h",
  14_400: "4h",
  86_400: "1d",
};

/** Bucket length for "All": the coarsest that keeps the whole span under ~250
 *  bars, so an hour-old token and a year-old one both read clearly. */
function allInterval(spanSec: number): number {
  for (const sec of [60, 300, 900, 3600, 14_400]) {
    if (spanSec / sec <= 250) return sec;
  }
  return 86_400;
}

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

interface IndexedTradeJson {
  readonly txHash: string;
  readonly blockNumber: string;
  readonly time: string;
  readonly side: string;
  readonly amountToken: string;
  readonly valueUsdE6: string;
  readonly priceUsdE18: string;
  readonly wallet: string;
}

/**
 * Full trade history for a token from the indexer, or null if it has none.
 *
 * Returns null rather than an empty array on failure so the caller can tell
 * "the indexer has nothing for this token" apart from "ask the chain instead".
 */
async function fetchIndexedHistory(token: Hex): Promise<SwapPoint[] | null> {
  try {
    const res = await fetch(`/api/tokens/${token}/market?trades=2000`, { cache: "no-store" });
    if (!res.ok) return null;
    const body = (await res.json()) as { trades?: IndexedTradeJson[] };
    const trades = body.trades;
    if (trades === undefined) return null;
    return trades.map((t) => ({
      block: BigInt(t.blockNumber),
      timeMs: new Date(t.time).getTime(),
      priceE18: BigInt(t.priceUsdE18),
      quoteVolume: BigInt(t.valueUsdE6),
      isBuy: t.side === "buy",
      wallet: t.wallet as Hex,
      tokenAmount: BigInt(t.amountToken),
      txHash: t.txHash as Hex,
    }));
  } catch {
    return null;
  }
}

interface IndexedCandleJson {
  readonly time: string;
  readonly open: string;
  readonly high: string;
  readonly low: string;
  readonly close: string;
  readonly volumeUsdE6: string;
}

/**
 * Stored candles for one interval, or null when the indexer cannot answer.
 *
 * This is what makes the long timeframes honest. Bucketing in the browser can
 * only ever see the trades that were fetched, so a busy token's daily view
 * would quietly stop at the 2,000-trade cap and show a partial history as if
 * it were the whole one. The indexer keeps every bucket from launch.
 */
async function fetchIndexedCandles(token: Hex, intervalSec: number): Promise<Candle[] | null> {
  const key = INTERVAL_PARAM[intervalSec];
  if (key === undefined) return null;
  try {
    // trades=1 because only the candles are wanted here; the trade feed is
    // already loaded once and does not need refetching per timeframe.
    const res = await fetch(`/api/tokens/${token}/market?interval=${key}&trades=1`, { cache: "no-store" });
    if (!res.ok) return null;
    const body = (await res.json()) as { candles?: IndexedCandleJson[] };
    if (body.candles === undefined) return null;
    return body.candles.map((c) => ({
      time: Math.floor(new Date(c.time).getTime() / 1000),
      open: Number(BigInt(c.open)) / 1e18,
      high: Number(BigInt(c.high)) / 1e18,
      low: Number(BigInt(c.low)) / 1e18,
      close: Number(BigInt(c.close)) / 1e18,
      volume: Number(BigInt(c.volumeUsdE6)) / 1e6,
    }));
  } catch {
    return null;
  }
}

/**
 * Extend the newest bar with the live spot price.
 *
 * Stored candles stop at whatever the indexer has written, which is a few
 * seconds behind at best. Without this the chart would sit frozen between
 * trades even while the price ticks, which reads as a broken chart.
 */
function withSpot(bars: readonly Candle[], spotE18: bigint | null, intervalSec: number): Candle[] {
  const out = [...bars];
  if (spotE18 === null) return out;
  const price = Number(spotE18) / 1e18;
  const now = Math.floor(Date.now() / 1000 / intervalSec) * intervalSec;
  const last = out[out.length - 1];
  if (last !== undefined && last.time === now) {
    out[out.length - 1] = {
      ...last,
      high: Math.max(last.high, price),
      low: Math.min(last.low, price),
      close: price,
    };
  } else if (last === undefined || now > last.time) {
    out.push({ time: now, open: last?.close ?? price, high: price, low: price, close: price, volume: 0 });
  }
  return out;
}

/** Top holders from the indexer, or null when it cannot answer. */
async function fetchIndexedHolders(token: Hex): Promise<Array<{ wallet: Hex; balance: bigint }> | null> {
  try {
    const res = await fetch(`/api/tokens/${token}/holders`, { cache: "no-store" });
    if (!res.ok) return null;
    const body = (await res.json()) as { holders?: Array<{ wallet: string; balance: string }> };
    if (body.holders === undefined) return null;
    return body.holders.map((h) => ({ wallet: h.wallet as Hex, balance: BigInt(h.balance) }));
  } catch {
    return null;
  }
}

/**
 * Trading terminal panels: TradingView-engine candles (live-ticking), trades
 * feed, holders. History from the indexer in one request, then 2s incremental
 * polling of the chain for the live tail.
 */
export function MarketPanels({ pool, token, pairToken, symbol, creator, chainKey = "arc" }: MarketPanelsProps) {
  const chain = getChain(chainKey);
  const formatQuoteUnits = (v: bigint): string => formatUnits(v, chain.quote.decimals);
  const arcPublic = usePublicClient({ chainId: chain.id });
  const [swaps, setSwaps] = useState<SwapPoint[] | null>(null);
  const [spotE18, setSpotE18] = useState<bigint | null>(null);
  const [tab, setTab] = useState<"chart" | "trades" | "holders">("chart");
  const [interval, setIntervalKey] = useState<(typeof INTERVALS)[number]>(INTERVALS[1]);
  const [holders, setHolders] = useState<Array<{ wallet: Hex; balance: bigint }> | null>(null);
  const [failed, setFailed] = useState(false);
  // Stored candles per bucket length. A null value means "asked, nothing there",
  // which is different from "not asked yet" and stops the fetch retrying.
  const [barsBySec, setBarsBySec] = useState<Record<number, Candle[] | null>>({});

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
      priceE18: priceUsdE18(l.args.sqrtPriceX96, tokenIsToken0, chain.quote.decimals),
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
      if (slot0 !== null && !cancelled) setSpotE18(priceUsdE18(slot0[0], tokenIsToken0, chain.quote.decimals));
    };

    const initial = async (): Promise<void> => {
      const tip = await arcPublic.getBlockNumber();
      const nowMs = Date.now();
      await readSpot(); // chart renders immediately, even with zero trades
      cursor = tip;
      timer = setTimeout(() => void poll(), POLL_MS);

      // History from the indexer, in one request, with real block timestamps.
      // The walk below is the fallback: it costs up to 24 getLogs calls from
      // every visitor's browser, and it can only reach as far back as the node
      // still keeps logs, so older trades were simply invisible.
      const seeded = await fetchIndexedHistory(token);
      if (seeded !== null && seeded.length > 0) {
        if (cancelled) return;
        setSwaps(seeded);
        return;
      }

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
      // Real balances over the token's whole history, in one request. The walk
      // below is the fallback and can only reach a couple of days back.
      const indexed = await fetchIndexedHolders(token);
      if (indexed !== null) {
        if (!cancelled) setHolders(indexed);
        return;
      }
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

  // "All" sizes its buckets from how long the token has actually been trading.
  const spanSec = useMemo(() => {
    if (s.length === 0) return 0;
    let lo = Number.POSITIVE_INFINITY;
    let hi = 0;
    for (const p of s) {
      if (p.timeMs < lo) lo = p.timeMs;
      if (p.timeMs > hi) hi = p.timeMs;
    }
    return Math.max(0, (hi - lo) / 1000);
  }, [s]);
  const effectiveSec = interval.sec === 0 ? allInterval(spanSec) : interval.sec;

  // Pull stored candles for whichever timeframe is showing. Each bucket length
  // is fetched once; the client-side bucketing below stays as the fallback for
  // tokens the indexer has nothing for.
  useEffect(() => {
    if (tab !== "chart" || effectiveSec in barsBySec) return undefined;
    let cancelled = false;
    void (async () => {
      const bars = await fetchIndexedCandles(token, effectiveSec);
      if (!cancelled) setBarsBySec((m) => ({ ...m, [effectiveSec]: bars }));
    })();
    return () => {
      cancelled = true;
    };
  }, [tab, effectiveSec, token, barsBySec]);

  const stored = barsBySec[effectiveSec] ?? null;
  const candles = useMemo(
    () =>
      stored !== null && stored.length > 0
        ? withSpot(stored, spotE18, effectiveSec)
        : toCandles(s, spotE18, effectiveSec),
    [stored, s, spotE18, effectiveSec],
  );

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
        <div className="arch-scroll-x"><TradesTable chain={chain} swaps={s} symbol={symbol} /></div>
      ) : (
        <div className="arch-scroll-x"><HoldersTable chain={chain} holders={holders} pool={pool} symbol={symbol} /></div>
      )}
    </div>
  );
}

function TradesTable({ swaps, symbol, chain }: { readonly swaps: SwapPoint[]; readonly symbol: string; readonly chain: LaunchChain }) {
  const formatQuoteUnits = (v: bigint): string => formatUnits(v, chain.quote.decimals);
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
          href={explorerTx(chain, s.txHash)}
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

function HoldersTable({ holders, pool, symbol, chain }: { readonly holders: Array<{ wallet: Hex; balance: bigint }> | null; readonly pool: Hex; readonly symbol: string; readonly chain: LaunchChain }) {
  if (holders === null) return <p className="arch-note">Reading holders…</p>;
  if (holders.length === 0) return <p className="arch-note">No holders yet.</p>;
  const SUPPLY = 1_000_000_000n * 10n ** 18n;
  const BURN = "0x000000000000000000000000000000000000dead";
  return (
    <div style={{ display: "grid", gap: "0.25rem" }}>
      <div style={{ display: "grid", gridTemplateColumns: "32px 1fr 140px 70px", gap: "0.5rem" }} className="arch-note">
        <span>#</span><span>Wallet</span><span>Amount</span><span>Supply</span>
      </div>
      {holders.map((h, i) => {
        const lower = h.wallet.toLowerCase();
        const isPool = lower === pool.toLowerCase();
        // Burned supply is a real balance at a real address, but it is nobody's
        // holding — say so rather than listing it as the third largest holder.
        const isBurn = lower === BURN;
        const pctBps = Number((h.balance * 10_000n) / SUPPLY);
        return (
          <a key={h.wallet} href={explorerAddress(chain, h.wallet)} target="_blank" rel="noreferrer"
            style={{ display: "grid", gridTemplateColumns: "32px 1fr 140px 70px", gap: "0.5rem", fontSize: "0.85rem", padding: "0.25rem 0", borderBottom: "1px solid var(--arch-border)" }}>
            <span className="arch-note">{i + 1}</span>
            <span style={{ fontFamily: "monospace" }}>
              {h.wallet.slice(0, 6)}…{h.wallet.slice(-4)}
              {isPool ? <span className="arch-note"> · LP (locked)</span> : null}
              {isBurn ? <span className="arch-note"> · burned</span> : null}
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
