import { parseAbiItem, type Hex, type PublicClient } from "viem";
import { getDb } from "@/lib/db";
import type { LaunchpadToken } from "@/lib/launchpad";

/**
 * Protocol-wide stats for the hero bar: trade count and volume (24h and
 * all-time) across every launch pool. Prefers the indexer's Postgres (true
 * all-time history); falls back to a chunked chain walk that covers the RPC's
 * full retention window. Cached in-memory so the ISR'd homepage stays fast.
 */

const swapEvent = parseAbiItem(
  "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)",
);

export interface ProtocolStats {
  readonly trades: number;
  readonly volAllUnits: bigint; // 6-decimal USD
  readonly vol24hUnits: bigint;
}

const TTL_MS = 60_000;
let cache: { at: number; value: ProtocolStats } | null = null;
let inFlight: Promise<ProtocolStats> | null = null;

const CHUNK = 45_000n;
const MAX_CHUNKS = 10; // ~450k blocks — beyond the RPC pruning horizon
const BLOCKS_24H = 172_800n; // ~0.5s Arc blocks

async function fromDb(): Promise<ProtocolStats | null> {
  const sql = getDb();
  if (sql === null) return null;
  try {
    const [all] = await sql<{ trades: string; vol: string }[]>`
      SELECT COUNT(*)::text AS trades, COALESCE(SUM(volume_usd_e6), 0)::text AS vol FROM swaps
    `;
    const [day] = await sql<{ vol: string }[]>`
      SELECT COALESCE(SUM(volume_usd_e6), 0)::text AS vol FROM swaps
      WHERE block_time > now() - interval '24 hours'
    `;
    if (all === undefined) return null;
    const trades = Number(all.trades);
    if (trades === 0) return null; // indexer empty — chain walk knows better
    return { trades, volAllUnits: BigInt(all.vol), vol24hUnits: BigInt(day?.vol ?? "0") };
  } catch {
    return null;
  }
}

async function fromChain(client: PublicClient, tokens: readonly LaunchpadToken[]): Promise<ProtocolStats> {
  if (tokens.length === 0) return { trades: 0, volAllUnits: 0n, vol24hUnits: 0n };
  const pools = tokens.map((t) => t.pool);
  const isToken0 = new Map<string, boolean>(
    tokens.map((t) => [t.pool.toLowerCase(), t.token.toLowerCase() < t.pairToken.toLowerCase()]),
  );
  const tip = await client.getBlockNumber();
  const cutoff24h = tip > BLOCKS_24H ? tip - BLOCKS_24H : 0n;

  let trades = 0;
  let volAll = 0n;
  let vol24h = 0n;
  let end = tip;
  for (let i = 0; i < MAX_CHUNKS; i++) {
    const start = end >= CHUNK ? end - CHUNK + 1n : 0n;
    let logs;
    try {
      logs = await client.getLogs({ address: pools as Hex[], event: swapEvent, fromBlock: start, toBlock: end });
    } catch {
      break; // pruning horizon
    }
    for (const l of logs) {
      const t0 = isToken0.get(l.address.toLowerCase());
      if (t0 === undefined) continue;
      const quoteDelta = t0 ? (l.args.amount1 ?? 0n) : (l.args.amount0 ?? 0n);
      const vol = quoteDelta < 0n ? -quoteDelta : quoteDelta;
      trades += 1;
      volAll += vol;
      if ((l.blockNumber ?? 0n) >= cutoff24h) vol24h += vol;
    }
    if (start === 0n) break;
    end = start - 1n;
  }
  return { trades, volAllUnits: volAll, vol24hUnits: vol24h };
}

export async function fetchProtocolStats(
  client: PublicClient,
  tokens: readonly LaunchpadToken[],
): Promise<ProtocolStats> {
  if (cache !== null && Date.now() - cache.at < TTL_MS) return cache.value;
  if (inFlight !== null) return inFlight;
  inFlight = (async () => {
    const [db, chain] = await Promise.all([fromDb(), fromChain(client, tokens).catch(() => null)]);
    // Take whichever source saw more history (DB grows past the RPC horizon).
    const value =
      db !== null && (chain === null || db.trades >= chain.trades)
        ? db
        : chain ?? { trades: 0, volAllUnits: 0n, vol24hUnits: 0n };
    cache = { at: Date.now(), value };
    return value;
  })();
  try {
    return await inFlight;
  } finally {
    inFlight = null;
  }
}
