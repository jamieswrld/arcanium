import "server-only";
import { parseAbiItem, type Hex, type Log } from "viem";
import { cached } from "@/lib/kvCache";
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

/**
 * Only the fields consumers actually read.
 *
 * viem's Log carries topics, data, indexes and more. This window is cached
 * across instances, so it is projected down to what market stats and the pulse
 * use — keeping the stored payload small and the shape stable.
 */
export interface SwapLog {
  readonly address: Hex;
  readonly blockNumber: bigint;
  readonly transactionHash: Hex;
  readonly args: {
    readonly amount0: bigint;
    readonly amount1: bigint;
    readonly sqrtPriceX96: bigint;
  };
}

type RawSwapLog = Log<bigint, number, false, typeof swapEvent, true>;

function lean(l: RawSwapLog): SwapLog {
  return {
    address: l.address,
    blockNumber: l.blockNumber ?? 0n,
    transactionHash: l.transactionHash ?? ("0x" as Hex),
    args: {
      amount0: l.args.amount0 ?? 0n,
      amount1: l.args.amount1 ?? 0n,
      sqrtPriceX96: l.args.sqrtPriceX96 ?? 0n,
    },
  };
}

const CHUNK = 9_500n;
/** 0.506s blocks -> ~170.7k blocks in 24h. 18 chunks covers the window. */
const CHUNKS_24H = 18;
const CONCURRENCY = 6;
const TTL_MS = 60_000;

/** Long enough for 18 chunks on a healthy RPC, short enough to leave the
 *  caller room to fall back before its own deadline. */
const BUILD_DEADLINE_MS = 8_000;

function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("swap window timed out")), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

export interface SwapWindow {
  readonly tip: bigint;
  readonly logs: readonly SwapLog[];
  /** Oldest block actually covered, so callers can be honest about range. */
  readonly fromBlock: bigint;
  /** Blocks per second on Arc, for ageing events without a getBlock per row. */
  readonly secondsPerBlock: number;
}

const SECONDS_PER_BLOCK = 0.506;

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
          .catch(() => [] as RawSwapLog[]),
      ),
    );
    for (const set of sets) for (const l of set as RawSwapLog[]) collected.push(lean(l));
  }

  const oldest = ranges[ranges.length - 1]?.from ?? tip;
  return { tip, logs: collected, fromBlock: oldest, secondsPerBlock: SECONDS_PER_BLOCK };
}

/** The 24h Swap window for our pools. Shared by market stats, protocol stats
 *  and the activity feed so the chain is walked once per minute, not per view. */
export async function fetchSwapWindow(tokens: readonly LaunchpadToken[]): Promise<SwapWindow> {
  // Cached across instances, not just in-process. On serverless each request
  // can land on a fresh instance, so a purely in-memory memo never gets a second
  // hit and every visitor pays the whole 18-chunk walk.
  return cached(`arc:swapwindow:${tokens.length}`, TTL_MS, async () => {
    // Deliberately no catch-to-empty here. Swallowing a failed walk and
    // returning zero logs is indistinguishable, downstream, from "nothing
    // traded" — which is how an RPC hiccup turned into every 24h volume
    // reading 0.00, trending reordering itself and real markets dropping off
    // the front page. Letting it throw lets the cache serve the last good
    // window instead, which is stale but true.
    //
    // Bounded so it fails fast: the caller has its own deadline, and a walk
    // that is going to miss it should hand over to the stale path early rather
    // than burn the whole budget first.
    return withDeadline(build(tokens), BUILD_DEADLINE_MS);
  });
}
