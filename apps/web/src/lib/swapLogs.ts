import "server-only";
import { parseAbiItem, type Hex, type Log } from "viem";
import { arcPublicClient, type LaunchpadToken } from "@/lib/launchpad";

/**
 * One shared walk of Swap logs.
 *
 * Explore needs the same events three times over — per-token market data, the
 * protocol stat strip, and ARC PULSE. Each used to walk the chain itself: 18,
 * 20 and 3 chunks respectively, so 41 getLogs requests per cold render, all
 * fetching overlapping ranges of the same event from the same pools. At ~700ms
 * per request that is most of the page's load time, and the reason the skeleton
 * sat on screen.
 *
 * Now the window is fetched once, cached, and every consumer derives what it
 * needs from the result. Cold cost drops to a single 18-chunk walk; warm
 * renders touch the chain not at all.
 *
 * Arc's public RPC refuses a getLogs range much above 10k blocks (measured:
 * 10,000 succeeds, 15,000 fails) and drops large parallel bursts, hence the
 * chunk size and the modest concurrency.
 */

export const swapEvent = parseAbiItem(
  "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)",
);

export type SwapLog = Log<bigint, number, false, typeof swapEvent, true>;

const CHUNK = 9_500n;
/** 0.506s blocks -> ~170.7k blocks in 24h. 18 chunks covers the window. */
const CHUNKS_24H = 18;
const CONCURRENCY = 6;
const TTL_MS = 60_000;

export interface SwapWindow {
  readonly tip: bigint;
  readonly logs: readonly SwapLog[];
  /** Oldest block actually covered, so callers can be honest about range. */
  readonly fromBlock: bigint;
  /** Blocks per second on Arc, for ageing events without a getBlock per row. */
  readonly secondsPerBlock: number;
}

const SECONDS_PER_BLOCK = 0.506;

let cache: { at: number; value: SwapWindow } | null = null;
let inFlight: Promise<SwapWindow> | null = null;

async function build(tokens: readonly LaunchpadToken[]): Promise<SwapWindow> {
  const client = arcPublicClient();
  const tip = await client.getBlockNumber();
  const empty: SwapWindow = { tip, logs: [], fromBlock: tip, secondsPerBlock: SECONDS_PER_BLOCK };
  if (tokens.length === 0) return empty;

  const pools = tokens.map((t) => t.pool) as Hex[];
  const ranges = Array.from({ length: CHUNKS_24H }, (_, i) => {
    const to = tip - BigInt(i) * CHUNK;
    return { from: to > CHUNK ? to - CHUNK + 1n : 0n, to };
  });

  const collected: SwapLog[] = [];
  for (let i = 0; i < ranges.length; i += CONCURRENCY) {
    const batch = ranges.slice(i, i + CONCURRENCY);
    const sets = await Promise.all(
      batch.map((r) =>
        client
          .getLogs({ address: pools, event: swapEvent, fromBlock: r.from, toBlock: r.to })
          // A failed range is skipped, never fatal: older ranges can sit past the
          // node's pruning horizon while newer ones read perfectly.
          .catch(() => [] as SwapLog[]),
      ),
    );
    for (const s of sets) collected.push(...(s as SwapLog[]));
  }

  const oldest = ranges[ranges.length - 1]?.from ?? tip;
  return { tip, logs: collected, fromBlock: oldest, secondsPerBlock: SECONDS_PER_BLOCK };
}

/** The 24h Swap window for our pools. Shared by market stats, protocol stats
 *  and the activity feed so the chain is walked once per minute, not per view. */
export async function fetchSwapWindow(tokens: readonly LaunchpadToken[]): Promise<SwapWindow> {
  if (cache !== null && Date.now() - cache.at < TTL_MS) return cache.value;
  if (inFlight !== null) return inFlight;
  inFlight = (async () => {
    const value = await build(tokens).catch(
      async (): Promise<SwapWindow> => ({
        tip: 0n,
        logs: [],
        fromBlock: 0n,
        secondsPerBlock: SECONDS_PER_BLOCK,
      }),
    );
    cache = { at: Date.now(), value };
    return value;
  })();
  try {
    return await inFlight;
  } finally {
    inFlight = null;
  }
}
