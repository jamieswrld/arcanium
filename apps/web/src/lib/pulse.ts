import "server-only";
import { parseAbiItem, type Hex } from "viem";
import { arcPublicClient, type LaunchpadToken } from "@/lib/launchpad";
import { getChain } from "@/lib/chains";
import { fetchSwapWindow, type SwapLog } from "@/lib/swapLogs";

/**
 * ARC PULSE — recent protocol activity, from real indexed events.
 *
 * Every row is an on-chain log. Nothing is generated, sampled or padded: an
 * empty pulse means the chain was quiet, and that is the honest answer.
 *
 * Trades come from the shared Swap window rather than a separate walk. Launches
 * are a different event on a different address set, so they still need their own
 * request — but only over the newest slice, since a launch older than that will
 * already be visible in the market table.
 *
 * Graduation is deliberately absent. There is no graduation event on-chain — it
 * is a threshold on the pool's balance — so surfacing it here would mean
 * inventing a timestamp for something that never happened at a moment.
 */

const launchedEvent = parseAbiItem(
  "event Launched(address indexed token, address indexed creator, address pairToken, address pool, uint256 positionId, string metadataUri)",
);

/** Launches are read over the newest ~4h only; older ones are old news here. */
const LAUNCH_LOOKBACK = 28_500n;
const TTL_MS = 20_000;

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

let cache: { at: number; value: PulseEvent[] } | null = null;
let inFlight: Promise<PulseEvent[]> | null = null;

function toUsdMicro(raw: bigint, decimals: number): bigint {
  if (decimals === 6) return raw;
  if (decimals > 6) return raw / 10n ** BigInt(decimals - 6);
  return raw * 10n ** BigInt(6 - decimals);
}

async function build(tokens: readonly LaunchpadToken[]): Promise<PulseEvent[]> {
  if (tokens.length === 0) return [];
  const chain = getChain("arc");
  const client = arcPublicClient();

  const { tip, logs, secondsPerBlock } = await fetchSwapWindow(tokens);

  const byPool = new Map(
    tokens.map((t) => [
      t.pool.toLowerCase(),
      { token: t.token, symbol: t.symbol, tokenIsToken0: t.token.toLowerCase() < t.pairToken.toLowerCase() },
    ]),
  );
  const byToken = new Map(tokens.map((t) => [t.token.toLowerCase(), t.symbol]));

  const age = (block: bigint): number => Math.max(0, Math.round(Number(tip - block) * secondsPerBlock));
  const out: PulseEvent[] = [];

  for (const log of logs as readonly SwapLog[]) {
    const pool = byPool.get(log.address.toLowerCase());
    if (pool === undefined) continue;
    // The quote-side delta is what the trade was worth; its sign gives the
    // direction — quote flowing into the pool is a buy.
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

  const launchLogs = await client
    .getLogs({
      address: [...chain.factories],
      event: launchedEvent,
      fromBlock: tip > LAUNCH_LOOKBACK ? tip - LAUNCH_LOOKBACK : 0n,
      toBlock: tip,
    })
    .catch(() => []);

  for (const log of launchLogs) {
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

  return out
    .sort((a, b) => (b.blockNumber > a.blockNumber ? 1 : b.blockNumber < a.blockNumber ? -1 : 0))
    .slice(0, 24);
}

/** Recent activity, cached briefly so the feed does not re-derive per render. */
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
