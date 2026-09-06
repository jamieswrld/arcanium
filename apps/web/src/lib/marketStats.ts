import "server-only";
import { parseAbiItem, type Hex } from "viem";
import { arcPublicClient, priceUsdE18, type LaunchpadToken } from "@/lib/launchpad";
import { getChain } from "@/lib/chains";

/**
 * Per-token 24h market data, derived entirely from Swap logs.
 *
 * Two figures the market table needs and could not previously show:
 *
 *   volume  — the quote-side amount of every swap in the window.
 *   change  — a real percentage, not an estimate. Uniswap's Swap event carries
 *             sqrtPriceX96 *after* the trade, so the oldest swap in the window
 *             gives the price 24h ago exactly. No price oracle, no history
 *             table, no guessing.
 *
 * A token with no swaps in the window returns `change: null`, and the UI shows
 * a dash. That is the truthful answer — inventing 0.00% would imply the price
 * was measured and found unchanged.
 */

const swapEvent = parseAbiItem(
  "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)",
);

/** Arc's public RPC rejects getLogs ranges much above 10k blocks. */
const CHUNK = 9_500n;
/**
 * Windows we can actually serve.
 *
 * At 0.506s blocks: 1h is ~7.1k blocks (one request), 24h is ~170.7k (18).
 * 7d would be ~1.2M blocks — 126 sequential-ish requests against a rate-limited
 * public RPC — and "all time" is unreachable by getLogs at any price. Those are
 * omitted rather than shipped as buttons that quietly return partial data.
 */
export type MarketWindow = "1h" | "24h";
const CHUNKS: Record<MarketWindow, number> = { "1h": 1, "24h": 18 };
/** The same RPC drops large parallel bursts; five at a time is comfortable. */
const CONCURRENCY = 5;

const TTL_MS = 60_000;
const cache = new Map<MarketWindow, { at: number; value: Map<string, TokenMarket> }>();
const inFlight = new Map<MarketWindow, Promise<Map<string, TokenMarket>>>();

export interface TokenMarket {
  /** Quote volume over the window, in 6-decimal USD units. */
  readonly volumeUnits: bigint;
  readonly trades: number;
  /** Percent change over the window, or null when there were no trades. */
  readonly changePct: number | null;
}

export const EMPTY_MARKET: TokenMarket = { volumeUnits: 0n, trades: 0, changePct: null };

function toUsdMicro(raw: bigint, decimals: number): bigint {
  if (decimals === 6) return raw;
  if (decimals > 6) return raw / 10n ** BigInt(decimals - 6);
  return raw * 10n ** BigInt(6 - decimals);
}

async function build(tokens: readonly LaunchpadToken[], window: MarketWindow): Promise<Map<string, TokenMarket>> {
  const out = new Map<string, TokenMarket>();
  if (tokens.length === 0) return out;

  const chain = getChain("arc");
  const client = arcPublicClient();
  const tip = await client.getBlockNumber();
  const pools = tokens.map((t) => t.pool) as Hex[];

  const byPool = new Map(
    tokens.map((t) => [
      t.pool.toLowerCase(),
      { token: t.token.toLowerCase(), tokenIsToken0: t.token.toLowerCase() < t.pairToken.toLowerCase(), current: t.priceE18 },
    ]),
  );

  const ranges = Array.from({ length: CHUNKS[window] }, (_, i) => {
    const to = tip - BigInt(i) * CHUNK;
    return { from: to > CHUNK ? to - CHUNK + 1n : 0n, to };
  });

  // Accumulate per pool. `oldest` tracks the earliest swap seen so far, which is
  // what gives us the reference price for the change calculation.
  const acc = new Map<string, { volume: bigint; trades: number; oldestBlock: bigint; oldestSqrt: bigint }>();

  for (let i = 0; i < ranges.length; i += CONCURRENCY) {
    const batch = ranges.slice(i, i + CONCURRENCY);
    const sets = await Promise.all(
      batch.map((r) =>
        client.getLogs({ address: pools, event: swapEvent, fromBlock: r.from, toBlock: r.to }).catch(() => []),
      ),
    );
    for (const logs of sets) {
      for (const log of logs) {
        const key = log.address.toLowerCase();
        const pool = byPool.get(key);
        if (pool === undefined) continue;
        const quoteDelta = pool.tokenIsToken0 ? (log.args.amount1 ?? 0n) : (log.args.amount0 ?? 0n);
        const vol = quoteDelta < 0n ? -quoteDelta : quoteDelta;
        const block = log.blockNumber ?? tip;
        const sqrt = log.args.sqrtPriceX96 ?? 0n;

        const prev = acc.get(key);
        if (prev === undefined) {
          acc.set(key, { volume: vol, trades: 1, oldestBlock: block, oldestSqrt: sqrt });
        } else {
          prev.volume += vol;
          prev.trades += 1;
          if (block < prev.oldestBlock) {
            prev.oldestBlock = block;
            prev.oldestSqrt = sqrt;
          }
        }
      }
    }
  }

  for (const [key, pool] of byPool) {
    const a = acc.get(key);
    if (a === undefined || a.trades === 0) {
      out.set(pool.token, EMPTY_MARKET);
      continue;
    }
    // Price implied by the oldest swap in the window, in the same e18 scale as
    // the current price, so the ratio is directly comparable.
    const then = a.oldestSqrt === 0n ? 0n : priceUsdE18(a.oldestSqrt, pool.tokenIsToken0, chain.quote.decimals);
    const change =
      then === 0n
        ? null
        : // Percent to two decimals, computed in bigint then scaled down, so no
          // float ever touches the price itself.
          Number(((pool.current - then) * 10_000n) / then) / 100;

    out.set(pool.token, {
      volumeUnits: toUsdMicro(a.volume, chain.quote.decimals),
      trades: a.trades,
      changePct: change,
    });
  }

  return out;
}

/** Per-token market data for a window, keyed by lowercased token address. */
export async function fetchMarketStats(
  tokens: readonly LaunchpadToken[],
  window: MarketWindow = "24h",
): Promise<Map<string, TokenMarket>> {
  const hit = cache.get(window);
  if (hit !== undefined && Date.now() - hit.at < TTL_MS) return hit.value;
  const pending = inFlight.get(window);
  if (pending !== undefined) return pending;

  const run = (async () => {
    const value = await build(tokens, window).catch(() => new Map<string, TokenMarket>());
    cache.set(window, { at: Date.now(), value });
    return value;
  })();
  inFlight.set(window, run);
  try {
    return await run;
  } finally {
    inFlight.delete(window);
  }
}
