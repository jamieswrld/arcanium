import "server-only";
import { parseAbiItem, type Hex, type PublicClient } from "viem";
import { arcPublicClient, type LaunchpadToken } from "@/lib/launchpad";
import { getChain } from "@/lib/chains";

/**
 * ARC PULSE — recent protocol activity, from real indexed events.
 *
 * Every row here is an on-chain log. Nothing is generated, sampled or padded:
 * an empty pulse means the chain was quiet, and that is the honest answer.
 *
 * Two event sources:
 *   Swap      on our pools -> BUY / SELL, with the quote-side amount
 *   Launched  on our factories -> LAUNCH
 *
 * Graduation is deliberately absent. There is no graduation event on-chain —
 * it is a threshold on the pool's balance — so surfacing it here would mean
 * inventing a timestamp for something that never happened at a specific moment.
 */

const swapEvent = parseAbiItem(
  "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)",
);
const launchedEvent = parseAbiItem(
  "event Launched(address indexed token, address indexed creator, address pairToken, address pool, uint256 positionId, string metadataUri)",
);

/** Arc's public RPC rejects a getLogs range much above 10k blocks. */
const CHUNK = 9_500n;
/** ~28.5k blocks at 0.506s ≈ 4 hours of history, in three parallel requests. */
const CHUNKS = 3;
/** Measured on Arc: steady 0.506s blocks. Used to age events without paying a
 *  getBlock call per row — the drift over a few hours is a second or two. */
const SECONDS_PER_BLOCK = 0.506;

const TTL_MS = 20_000;
let cache: { at: number; value: PulseEvent[] } | null = null;
let inFlight: Promise<PulseEvent[]> | null = null;

export interface PulseEvent {
  readonly kind: "buy" | "sell" | "launch";
  readonly token: Hex;
  readonly symbol: string;
  /** Quote-side value in 6-decimal USD units. Zero for launches. */
  readonly valueUnits: bigint;
  readonly blockNumber: bigint;
  readonly secondsAgo: number;
  readonly txHash: Hex;
}

function toUsdMicro(raw: bigint, decimals: number): bigint {
  if (decimals === 6) return raw;
  if (decimals > 6) return raw / 10n ** BigInt(decimals - 6);
  return raw * 10n ** BigInt(6 - decimals);
}

async function build(tokens: readonly LaunchpadToken[]): Promise<PulseEvent[]> {
  if (tokens.length === 0) return [];
  const chain = getChain("arc");
  const client: PublicClient = arcPublicClient();
  const tip = await client.getBlockNumber();

  const byPool = new Map(
    tokens.map((t) => [
      t.pool.toLowerCase(),
      { token: t.token, symbol: t.symbol, tokenIsToken0: t.token.toLowerCase() < t.pairToken.toLowerCase() },
    ]),
  );
  const byToken = new Map(tokens.map((t) => [t.token.toLowerCase(), t.symbol]));
  const pools = tokens.map((t) => t.pool) as Hex[];

  const ranges = Array.from({ length: CHUNKS }, (_, i) => {
    const to = tip - BigInt(i) * CHUNK;
    return { from: to > CHUNK ? to - CHUNK + 1n : 0n, to };
  });

  const [swapSets, launchSets] = await Promise.all([
    Promise.all(
      ranges.map((r) =>
        client.getLogs({ address: pools, event: swapEvent, fromBlock: r.from, toBlock: r.to }).catch(() => []),
      ),
    ),
    Promise.all(
      ranges.map((r) =>
        client
          .getLogs({ address: [...chain.factories], event: launchedEvent, fromBlock: r.from, toBlock: r.to })
          .catch(() => []),
      ),
    ),
  ]);

  const age = (block: bigint): number => Math.max(0, Math.round(Number(tip - block) * SECONDS_PER_BLOCK));
  const out: PulseEvent[] = [];

  for (const log of swapSets.flat()) {
    const pool = byPool.get(log.address.toLowerCase());
    if (pool === undefined) continue;
    // The quote-side delta is what the trade was worth. Its sign tells us the
    // direction: quote leaving the trader (positive to the pool) is a buy.
    const quoteDelta = pool.tokenIsToken0 ? (log.args.amount1 ?? 0n) : (log.args.amount0 ?? 0n);
    if (quoteDelta === 0n) continue;
    out.push({
      kind: quoteDelta > 0n ? "buy" : "sell",
      token: pool.token,
      symbol: pool.symbol,
      valueUnits: toUsdMicro(quoteDelta < 0n ? -quoteDelta : quoteDelta, chain.quote.decimals),
      blockNumber: log.blockNumber ?? 0n,
      secondsAgo: age(log.blockNumber ?? tip),
      txHash: log.transactionHash ?? ("0x" as Hex),
    });
  }

  for (const log of launchSets.flat()) {
    const token = log.args.token;
    if (token === undefined) continue;
    out.push({
      kind: "launch",
      token,
      symbol: byToken.get(token.toLowerCase()) ?? "—",
      valueUnits: 0n,
      blockNumber: log.blockNumber ?? 0n,
      secondsAgo: age(log.blockNumber ?? tip),
      txHash: log.transactionHash ?? ("0x" as Hex),
    });
  }

  return out.sort((a, b) => (b.blockNumber > a.blockNumber ? 1 : b.blockNumber < a.blockNumber ? -1 : 0)).slice(0, 24);
}

/** Recent activity, cached briefly so the feed does not re-walk logs per render. */
export async function fetchPulse(tokens: readonly LaunchpadToken[]): Promise<PulseEvent[]> {
  if (cache !== null && Date.now() - cache.at < TTL_MS) return cache.value;
  if (inFlight !== null) return inFlight;
  inFlight = (async () => {
    const value = await build(tokens).catch(() => [] as PulseEvent[]);
    cache = { at: Date.now(), value };
    return value;
  })();
  try {
    return await inFlight;
  } finally {
    inFlight = null;
  }
}
