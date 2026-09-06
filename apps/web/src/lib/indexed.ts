import "server-only";
import type { Hex } from "viem";
import { getDb } from "@/lib/db";
import { isHidden, type LaunchpadToken } from "@/lib/launchpad";

/**
 * Reading the launchpad out of Postgres instead of off the chain.
 *
 * Arc's public RPC costs roughly 420ms per call regardless of how small the
 * request is — an eth_blockNumber, which does no work at all, measured between
 * 415ms and 672ms. Explore needs the token list, per-token pool state and a 24h
 * trade window, which is dozens of calls; no amount of caching in front of that
 * makes a cold page load fast, because the first visitor after every cache
 * expiry pays all of it.
 *
 * The indexer pays that cost once, in the background, on a machine that stays
 * running. Everything here is then a single indexed query.
 *
 * Every function returns null rather than throwing or guessing when the
 * indexer is missing, stale, or still backfilling. The caller falls back to the
 * on-chain path, so the site behaves exactly as it does today if the indexer
 * stops — slower, but never wrong and never empty.
 */

/** Beyond this the indexer is treated as dead and the chain path takes over. */
const MAX_STALENESS_MS = 120_000;
/** ~8 minutes of Arc blocks. Further behind than this is a backfill, not lag. */
const MAX_LAG_BLOCKS = 1_000n;

export interface IndexerHealth {
  readonly tip: bigint;
  readonly behind: bigint;
  readonly ageMs: number;
  readonly caughtUp: boolean;
}

interface HealthRow {
  readonly tip_block: string;
  readonly launches_block: string;
  readonly swaps_block: string;
  readonly updated_at: string;
}

/** Live status of the indexer, or null if there is no database or no row. */
export async function indexerHealth(): Promise<IndexerHealth | null> {
  const sql = getDb();
  if (sql === null) return null;
  try {
    const rows = await sql<HealthRow[]>`
      SELECT tip_block, launches_block, swaps_block, updated_at
      FROM indexer_health ORDER BY updated_at DESC LIMIT 1
    `;
    const row = rows[0];
    if (row === undefined) return null;
    const tip = BigInt(row.tip_block);
    const launches = BigInt(row.launches_block);
    const swaps = BigInt(row.swaps_block);
    const slowest = swaps < launches ? swaps : launches;
    const behind = tip > slowest ? tip - slowest : 0n;
    const ageMs = Date.now() - new Date(row.updated_at).getTime();
    return { tip, behind, ageMs, caughtUp: ageMs < MAX_STALENESS_MS && behind <= MAX_LAG_BLOCKS };
  } catch {
    // Tables not created yet — the indexer has never run against this database.
    return null;
  }
}

/**
 * Health, memoised briefly.
 *
 * Every reader below has to check it — serving indexed prices next to on-chain
 * volume would show a page whose numbers disagree with each other — but a page
 * render calls several of them, and they should not each pay for the lookup.
 */
const HEALTH_MEMO_MS = 10_000;
let healthMemo: { at: number; value: IndexerHealth | null } | null = null;

async function healthy(): Promise<boolean> {
  if (healthMemo === null || Date.now() - healthMemo.at > HEALTH_MEMO_MS) {
    healthMemo = { at: Date.now(), value: await indexerHealth().catch(() => null) };
  }
  return healthMemo.value?.caughtUp === true;
}

function hex(buf: Buffer): Hex {
  return `0x${buf.toString("hex")}` as Hex;
}

interface TokenRow {
  readonly token_address: Buffer;
  readonly name: string;
  readonly symbol: string;
  readonly creator: Buffer;
  readonly pair_token: Buffer;
  readonly pool_address: Buffer;
  readonly position_id: string;
  readonly graduated: boolean;
  readonly mode: number | null;
  readonly price_usd_e18: string | null;
  readonly market_cap_usd_e6: string | null;
  readonly quote_balance: string | null;
}

/**
 * Every launch, with its current market state, in one query.
 *
 * This replaces a factory-by-factory enumeration plus a multicall per token —
 * measured at 1.02s and 0.74s respectively from a warm local machine, and far
 * worse from a Vercel region.
 */
export async function indexedTokens(): Promise<LaunchpadToken[] | null> {
  if (!(await healthy())) return null;
  const sql = getDb();
  if (sql === null) return null;
  try {
    const rows = await sql<TokenRow[]>`
      SELECT
        t.token_address, t.name, t.symbol, t.creator, t.pair_token, t.pool_address,
        t.position_id, t.graduated, t.mode,
        s.price_usd_e18, s.market_cap_usd_e6, s.quote_balance
      FROM tokens t
      LEFT JOIN token_stats s ON s.token_address = t.token_address
      ORDER BY t.launch_time DESC
    `;
    // Hiding lives in fetchAllTokens on the chain path, so it has to be applied
    // here too or a hidden launch reappears the moment the indexer takes over.
    // Presentation only, as ever — the row stays in the database and the token
    // stays on-chain.
    return rows
      .filter((r) => !isHidden(hex(r.token_address)))
      .map((r) => ({
        token: hex(r.token_address),
        name: r.name,
        symbol: r.symbol,
        creator: hex(r.creator),
        pairToken: hex(r.pair_token),
        pool: hex(r.pool_address),
        positionId: BigInt(r.position_id),
        priceE18: BigInt(r.price_usd_e18 ?? "0"),
        marketCapUnits: BigInt(r.market_cap_usd_e6 ?? "0"),
        quoteBalance: BigInt(r.quote_balance ?? "0"),
        graduated: r.graduated,
        mode: r.mode,
      }));
  } catch {
    return null;
  }
}

/**
 * One launch by address.
 *
 * The chain version asks all four factory generations whether they know this
 * token, then makes five more reads on the answer. Here the factory that minted
 * it is already recorded, so it is a primary-key lookup.
 */
export async function indexedToken(address: string): Promise<LaunchpadToken | null> {
  if (!(await healthy())) return null;
  const sql = getDb();
  if (sql === null) return null;
  try {
    const rows = await sql<TokenRow[]>`
      SELECT
        t.token_address, t.name, t.symbol, t.creator, t.pair_token, t.pool_address,
        t.position_id, t.graduated, t.mode,
        s.price_usd_e18, s.market_cap_usd_e6, s.quote_balance
      FROM tokens t
      LEFT JOIN token_stats s ON s.token_address = t.token_address
      WHERE t.token_address = ${Buffer.from(address.slice(2), "hex")}
    `;
    const r = rows[0];
    if (r === undefined) return null;
    return {
      token: hex(r.token_address),
      name: r.name,
      symbol: r.symbol,
      creator: hex(r.creator),
      pairToken: hex(r.pair_token),
      pool: hex(r.pool_address),
      positionId: BigInt(r.position_id),
      priceE18: BigInt(r.price_usd_e18 ?? "0"),
      marketCapUnits: BigInt(r.market_cap_usd_e6 ?? "0"),
      quoteBalance: BigInt(r.quote_balance ?? "0"),
      graduated: r.graduated,
      mode: r.mode,
    };
  } catch {
    return null;
  }
}

export interface IndexedMarketStat {
  readonly volume24hUnits: bigint;
  /** Percent change over 24h, or null when the token has no trades in it. */
  readonly changePct: number | null;
  readonly buys: number;
  readonly sells: number;
}

interface StatRow {
  readonly token_address: Buffer;
  readonly volume_24h_usd_e6: string;
  readonly change_24h_bps: string | null;
  readonly buy_count: string;
  readonly sell_count: string;
}

/**
 * 24h volume and change per token, keyed by lowercased address.
 *
 * On the chain path these come from an eighteen-chunk getLogs walk shared
 * across the whole page. Here they are one row per token, already aggregated.
 */
export async function indexedMarketStats(): Promise<Record<string, IndexedMarketStat> | null> {
  if (!(await healthy())) return null;
  const sql = getDb();
  if (sql === null) return null;
  try {
    const rows = await sql<StatRow[]>`
      SELECT token_address, volume_24h_usd_e6, change_24h_bps, buy_count, sell_count
      FROM token_stats
    `;
    const out: Record<string, IndexedMarketStat> = {};
    for (const r of rows) {
      out[hex(r.token_address).toLowerCase()] = {
        volume24hUnits: BigInt(r.volume_24h_usd_e6),
        changePct: r.change_24h_bps === null ? null : Number(r.change_24h_bps) / 100,
        buys: Number(r.buy_count),
        sells: Number(r.sell_count),
      };
    }
    return out;
  } catch {
    return null;
  }
}

interface WindowRow {
  readonly token_address: Buffer;
  readonly vol: string;
  readonly trades: string;
  readonly first_price: string;
  readonly last_price: string;
}

/**
 * Volume, trade count and change over an arbitrary window, per token.
 *
 * The chain path can only offer 1h and 24h, because each extra hour is another
 * ~7,100 blocks of getLogs and 7d would be ~1.2M blocks — unreachable. Against
 * the swaps table the window is just a WHERE clause, so any period is the same
 * single query.
 */
export async function indexedMarketWindow(
  hours: number,
): Promise<Map<string, { volumeUnits: bigint; trades: number; changePct: number | null }> | null> {
  if (!(await healthy())) return null;
  const sql = getDb();
  if (sql === null) return null;
  try {
    const rows = await sql<WindowRow[]>`
      SELECT
        token_address,
        SUM(volume_usd_e6)::text AS vol,
        COUNT(*)::text           AS trades,
        (ARRAY_AGG(price_usd_e18 ORDER BY block_number, log_index))[1]::text           AS first_price,
        (ARRAY_AGG(price_usd_e18 ORDER BY block_number DESC, log_index DESC))[1]::text AS last_price
      FROM swaps
      WHERE block_time > now() - make_interval(hours => ${hours})
      GROUP BY token_address
    `;
    const out = new Map<string, { volumeUnits: bigint; trades: number; changePct: number | null }>();
    for (const r of rows) {
      const first = BigInt(r.first_price);
      const last = BigInt(r.last_price);
      out.set(hex(r.token_address).toLowerCase(), {
        volumeUnits: BigInt(r.vol),
        trades: Number(r.trades),
        // Percent to two decimals, computed in bigint and only then scaled, so
        // no float ever touches a price.
        changePct: first === 0n ? null : Number(((last - first) * 10_000n) / first) / 100,
      });
    }
    return out;
  } catch {
    return null;
  }
}

export interface IndexedActivity {
  readonly kind: "buy" | "sell" | "launch";
  readonly token: Hex;
  readonly symbol: string;
  /** Quote-side value in 6-decimal USD units. Zero for a launch. */
  readonly valueUnits: bigint;
  readonly blockNumber: bigint;
  readonly at: Date;
  readonly txHash: Hex;
}

interface ActivityRow {
  readonly kind: string;
  readonly token_address: Buffer;
  readonly symbol: string;
  readonly value_units: string;
  readonly block_number: string;
  readonly at: string;
  readonly tx_hash: Buffer;
}

/**
 * Recent trades and launches interleaved — the ARC PULSE feed.
 *
 * The chain version of this reads the shared 24h swap window and then makes a
 * separate getLogs call for launches, because they are a different event on a
 * different address set. Here both are rows in tables that are already ordered
 * by time, so it is one union and a LIMIT.
 */
export async function indexedPulse(limit = 24): Promise<IndexedActivity[] | null> {
  if (!(await healthy())) return null;
  const sql = getDb();
  if (sql === null) return null;
  try {
    const rows = await sql<ActivityRow[]>`
      (
        SELECT
          CASE WHEN s.is_buy THEN 'buy' ELSE 'sell' END AS kind,
          s.token_address, t.symbol,
          s.volume_usd_e6::text AS value_units,
          s.block_number::text  AS block_number,
          s.block_time          AS at,
          s.tx_hash
        FROM swaps s
        JOIN tokens t ON t.token_address = s.token_address
        ORDER BY s.block_time DESC, s.log_index DESC
        LIMIT ${limit}
      )
      UNION ALL
      (
        SELECT 'launch', token_address, symbol, '0', launch_block::text, launch_time, launch_tx_hash
        FROM tokens
        ORDER BY launch_time DESC
        LIMIT ${limit}
      )
      ORDER BY at DESC
      LIMIT ${limit}
    `;
    return rows
      .filter((r) => !isHidden(hex(r.token_address)))
      .map((r) => ({
        kind: r.kind === "buy" ? "buy" : r.kind === "sell" ? "sell" : "launch",
        token: hex(r.token_address),
        symbol: r.symbol,
        valueUnits: BigInt(r.value_units),
        blockNumber: BigInt(r.block_number),
        at: new Date(r.at),
        txHash: hex(r.tx_hash),
      }));
  } catch {
    return null;
  }
}

export interface IndexedProtocolStats {
  readonly totalVolumeUnits: bigint;
  readonly totalTrades: number;
  readonly launches: number;
  readonly graduated: number;
}

/**
 * Protocol totals. These are genuinely all-time here, which the on-chain path
 * could never claim — it could only ever see as far back as one getLogs window,
 * which is why the header had to say "Recent volume".
 */
export async function indexedProtocolStats(): Promise<IndexedProtocolStats | null> {
  if (!(await healthy())) return null;
  const sql = getDb();
  if (sql === null) return null;
  try {
    const rows = await sql<{ vol: string | null; trades: string; launches: string; grad: string }[]>`
      SELECT
        (SELECT COALESCE(SUM(volume_usd_e6), 0)::text FROM swaps)            AS vol,
        (SELECT COUNT(*)::text FROM swaps)                                    AS trades,
        (SELECT COUNT(*)::text FROM tokens)                                   AS launches,
        (SELECT COUNT(*)::text FROM tokens WHERE graduated)                   AS grad
    `;
    const r = rows[0];
    if (r === undefined) return null;
    return {
      totalVolumeUnits: BigInt(r.vol ?? "0"),
      totalTrades: Number(r.trades),
      launches: Number(r.launches),
      graduated: Number(r.grad),
    };
  } catch {
    return null;
  }
}
