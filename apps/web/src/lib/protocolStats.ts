import { parseAbiItem, type Hex, type PublicClient } from "viem";
import { getDb } from "@/lib/db";
import type { LaunchpadToken } from "@/lib/launchpad";
import { chainPublicClient } from "@/lib/chainRpc";
import type { ChainKey, LaunchChain } from "@/lib/chains";

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

/**
 * Multi-chain stats.
 *
 * The single-client version above only ever read Arc, so a real trade on
 * Robinhood or BNB showed as $0.00 volume — which is exactly what happened to a
 * $10 buy routed through GMGN. It also summed raw quote units while the
 * formatter assumes 6 decimals, so an 18-decimal quote like BNB's USDT would
 * have been overstated by 1e12.
 *
 * Both are fixed here: each chain is walked with its own client and its volume
 * normalised to 6-decimal USD before being summed.
 */

/** Approximate blocks in 24h, per chain — block times differ a lot. */
const BLOCKS_24H_BY_CHAIN: Record<ChainKey, bigint> = {
  arc: BLOCKS_24H,
  robinhood: 345_600n, // Arbitrum Orbit L2, ~0.25s blocks
  bnb: 115_200n, // ~0.75s blocks
};

/** Scale a chain's raw quote volume to the 6-decimal USD the UI formats. */
function toUsdMicro(raw: bigint, quoteDecimals: number): bigint {
  if (quoteDecimals === 6) return raw;
  if (quoteDecimals > 6) return raw / 10n ** BigInt(quoteDecimals - 6);
  return raw * 10n ** BigInt(6 - quoteDecimals);
}

async function fromOneChain(
  chain: LaunchChain,
  tokens: readonly LaunchpadToken[],
): Promise<ProtocolStats> {
  if (tokens.length === 0) return { trades: 0, volAllUnits: 0n, vol24hUnits: 0n };
  const client = chainPublicClient(chain);
  const isToken0 = new Map<string, boolean>(
    tokens.map((t) => [t.pool.toLowerCase(), t.token.toLowerCase() < t.pairToken.toLowerCase()]),
  );
  const pools = tokens.map((t) => t.pool) as Hex[];
  const tip = await client.getBlockNumber();
  const window24h = BLOCKS_24H_BY_CHAIN[chain.key];
  const cutoff24h = tip > window24h ? tip - window24h : 0n;

  let trades = 0;
  let volAll = 0n;
  let vol24h = 0n;
  let end = tip;
  for (let i = 0; i < MAX_CHUNKS; i++) {
    const start = end >= CHUNK ? end - CHUNK + 1n : 0n;
    let logs;
    try {
      logs = await client.getLogs({ address: pools, event: swapEvent, fromBlock: start, toBlock: end });
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
  const d = chain.quote.decimals;
  return { trades, volAllUnits: toUsdMicro(volAll, d), vol24hUnits: toUsdMicro(vol24h, d) };
}

let multiCache: { at: number; value: ProtocolStats } | null = null;
let multiInFlight: Promise<ProtocolStats> | null = null;

/** Stats summed across every chain, each read with its own client. */
export async function fetchProtocolStatsMulti(
  groups: readonly { readonly chain: LaunchChain; readonly tokens: readonly LaunchpadToken[] }[],
): Promise<ProtocolStats> {
  if (multiCache !== null && Date.now() - multiCache.at < TTL_MS) return multiCache.value;
  if (multiInFlight !== null) return multiInFlight;
  multiInFlight = (async () => {
    const per = await Promise.all(
      groups.map((g) =>
        fromOneChain(g.chain, g.tokens).catch(() => ({ trades: 0, volAllUnits: 0n, vol24hUnits: 0n })),
      ),
    );
    let value: ProtocolStats = {
      trades: per.reduce((n, p) => n + p.trades, 0),
      volAllUnits: per.reduce((n, p) => n + p.volAllUnits, 0n),
      vol24hUnits: per.reduce((n, p) => n + p.vol24hUnits, 0n),
    };
    // The indexer keeps true all-time history past the RPC's retention horizon,
    // so prefer it when it has seen more.
    const db = await fromDb().catch(() => null);
    if (db !== null && db.trades >= value.trades) value = db;
    multiCache = { at: Date.now(), value };
    return value;
  })();
  try {
    return await multiInFlight;
  } finally {
    multiInFlight = null;
  }
}
