import "server-only";
import { priceUsdE18, type LaunchpadToken } from "@/lib/launchpad";
import { getChain } from "@/lib/chains";
import { fetchSwapWindow, type SwapLog } from "@/lib/swapLogs";
import { indexedMarketWindow } from "@/lib/indexed";

/**
 * Per-token market data, derived from the shared Swap window.
 *
 * Two figures the market table needs:
 *
 *   volume  — the quote-side amount of every swap in the window.
 *   change  — a real percentage, not an estimate. Uniswap's Swap event carries
 *             sqrtPriceX96 after the trade, so the oldest swap in the window
 *             gives the price then, exactly. No oracle, no price history table.
 *
 * A token with no swaps returns `changePct: null` and the UI shows a dash.
 * Inventing 0.00% would imply the price was measured and found unchanged.
 *
 * This module no longer walks the chain itself — it filters logs that were
 * already fetched once for the whole page.
 */

/**
 * Windows we can serve. 1h is a slice of the same fetched data; anything longer
 * than 24h would need a materially bigger walk (7d is ~1.2M blocks) and "all
 * time" is unreachable by getLogs, so neither is offered rather than shipped as
 * a control returning partial data.
 */
export type MarketWindow = "1h" | "24h";
const WINDOW_BLOCKS: Record<MarketWindow, bigint> = { "1h": 7_100n, "24h": 170_700n };

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

/** Per-token market data for a window, keyed by lowercased token address. */
export async function fetchMarketStats(
  tokens: readonly LaunchpadToken[],
  window: MarketWindow = "24h",
): Promise<Map<string, TokenMarket>> {
  const out = new Map<string, TokenMarket>();
  if (tokens.length === 0) return out;

  // One indexed query instead of an eighteen-chunk getLogs walk. Null means the
  // indexer is absent or behind, and the chain path below takes over unchanged.
  const indexed = await indexedMarketWindow(window === "1h" ? 1 : 24).catch(() => null);
  if (indexed !== null) {
    for (const t of tokens) {
      const key = t.token.toLowerCase();
      out.set(key, indexed.get(key) ?? EMPTY_MARKET);
    }
    return out;
  }

  const chain = getChain("arc");
  const { tip, logs } = await fetchSwapWindow(tokens);
  const cutoff = tip > WINDOW_BLOCKS[window] ? tip - WINDOW_BLOCKS[window] : 0n;

  const byPool = new Map(
    tokens.map((t) => [
      t.pool.toLowerCase(),
      {
        token: t.token.toLowerCase(),
        tokenIsToken0: t.token.toLowerCase() < t.pairToken.toLowerCase(),
        current: t.priceE18,
      },
    ]),
  );

  const acc = new Map<string, { volume: bigint; trades: number; oldestBlock: bigint; oldestSqrt: bigint }>();

  for (const log of logs as readonly SwapLog[]) {
    const block = log.blockNumber ?? tip;
    if (block < cutoff) continue; // outside the requested window
    const key = log.address.toLowerCase();
    const pool = byPool.get(key);
    if (pool === undefined) continue;

    const quoteDelta = pool.tokenIsToken0 ? (log.args.amount1 ?? 0n) : (log.args.amount0 ?? 0n);
    const vol = quoteDelta < 0n ? -quoteDelta : quoteDelta;
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

  for (const [key, pool] of byPool) {
    const a = acc.get(key);
    if (a === undefined || a.trades === 0) {
      out.set(pool.token, EMPTY_MARKET);
      continue;
    }
    const then = a.oldestSqrt === 0n ? 0n : priceUsdE18(a.oldestSqrt, pool.tokenIsToken0, chain.quote.decimals);
    // Percent to two decimals, computed in bigint then scaled, so no float ever
    // touches the price itself.
    const change = then === 0n ? null : Number(((pool.current - then) * 10_000n) / then) / 100;

    out.set(pool.token, {
      volumeUnits: toUsdMicro(a.volume, chain.quote.decimals),
      trades: a.trades,
      changePct: change,
    });
  }

  return out;
}

/**
 * Re-scale a quote-asset amount to 6-decimal USD micro-units.
 *
 * Every USD figure in the UI is carried as micro-units so it stays an exact
 * integer; a quote asset with different decimals has to be brought onto that
 * scale before it can be compared or formatted.
 */
export function scaleToUsdMicro(raw: bigint, decimals: number): bigint {
  if (decimals === 6) return raw;
  if (decimals > 6) return raw / 10n ** BigInt(decimals - 6);
  return raw * 10n ** BigInt(6 - decimals);
}
