import "server-only";
import type { Hex } from "viem";
import { getDb } from "@/lib/db";
import { isHidden, type LaunchpadToken } from "@/lib/launchpad";
import { getChain } from "@/lib/chains";

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

/**
 * Every query here is scoped to Arc mainnet.
 *
 * This database has been indexed against Arc testnet in the past, and those
 * rows are still in it — one token and one swap on chain 5042002. The tables
 * carry a chain_id for exactly this reason; leaving it out of the WHERE clause
 * put a token with no code on mainnet into the live listing. Nothing is deleted
 * to fix that: the rows are real history for the chain they belong to, they
 * simply are not this chain.
 */
const CHAIN_ID = getChain("arc").id;

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
      FROM indexer_health WHERE chain_id = ${CHAIN_ID}
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

/**
 * Whether the database can be read at all, regardless of how current it is.
 *
 * The distinction this draws is the whole point. A 24h volume from a stale
 * indexer is wrong — the window has moved and the numbers have not. An
 * all-time total from a stale indexer is merely *behind*: every row it has is
 * still true, it is just missing the most recent few minutes.
 *
 * Gating both on the same freshness check meant an indexer that paused for an
 * hour erased all-time volume, the launch count and the graduated count from
 * the site entirely, when the data was sitting in Postgres the whole time.
 * Undercounting by an hour is a far better answer than showing nothing.
 */
async function reachable(): Promise<boolean> {
  if (healthMemo === null || Date.now() - healthMemo.at > HEALTH_MEMO_MS) {
    healthMemo = { at: Date.now(), value: await indexerHealth().catch(() => null) };
  }
  return healthMemo.value !== null;
}

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
  /** Null for a v4 launch: liquidity belongs to the launchpad contract, not to
   *  an NFT, so there is no position to identify. */
  readonly position_id: string | null;
  readonly protocol?: string | null;
  readonly pool_id?: Buffer | null;
  readonly graduated: boolean;
  readonly mode: number | null;
  readonly price_usd_e18: string | null;
  readonly market_cap_usd_e6: string | null;
  readonly quote_balance: string | null;
  readonly launch_time: Date;
  readonly holder_count: number | null;
}

/**
 * Every launch, with its current market state, in one query.
 *
 * This replaces a factory-by-factory enumeration plus a multicall per token —
 * measured at 1.02s and 0.74s respectively from a warm local machine, and far
 * worse from a Vercel region.
 */
export async function indexedTokens(): Promise<LaunchpadToken[] | null> {
  if (!(await reachable())) return null;
  const sql = getDb();
  if (sql === null) return null;
  try {
    const rows = await sql<TokenRow[]>`
      SELECT
        t.token_address, t.name, t.symbol, t.creator, t.pair_token, t.pool_address,
        t.position_id, t.protocol, t.pool_id, t.graduated, t.mode, t.launch_time,
        s.price_usd_e18, s.market_cap_usd_e6, s.quote_balance, s.holder_count
      FROM tokens t
      LEFT JOIN token_stats s ON s.token_address = t.token_address
      WHERE t.chain_id = ${CHAIN_ID}
      ORDER BY t.launch_time DESC
    `;
    // Hiding lives in fetchAllTokens on the chain path, so it has to be applied
    // here too or a hidden launch reappears the moment the indexer takes over.
    // Presentation only, as ever — the row stays in the database and the token
    // stays on-chain.
    return rows
      .filter((r) => !isHidden(hex(r.token_address)))
      .map((r) => ({
        protocol: (r.protocol === "v4" ? "v4" : "v3") as "v3" | "v4",
        token: hex(r.token_address),
        name: r.name,
        symbol: r.symbol,
        creator: hex(r.creator),
        pairToken: hex(r.pair_token),
        pool: hex(r.pool_address),
        positionId: r.position_id === null ? 0n : BigInt(r.position_id),
        priceE18: BigInt(r.price_usd_e18 ?? "0"),
        marketCapUnits: BigInt(r.market_cap_usd_e6 ?? "0"),
        quoteBalance: BigInt(r.quote_balance ?? "0"),
        graduated: r.graduated,
        mode: r.mode,
        launchTime: r.launch_time,
        holderCount: r.holder_count,
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
  if (!(await reachable())) return null;
  const sql = getDb();
  if (sql === null) return null;
  try {
    const rows = await sql<TokenRow[]>`
      SELECT
        t.token_address, t.name, t.symbol, t.creator, t.pair_token, t.pool_address,
        t.position_id, t.protocol, t.pool_id, t.graduated, t.mode, t.launch_time,
        s.price_usd_e18, s.market_cap_usd_e6, s.quote_balance, s.holder_count
      FROM tokens t
      LEFT JOIN token_stats s ON s.token_address = t.token_address
      WHERE t.token_address = ${Buffer.from(address.slice(2), "hex")} AND t.chain_id = ${CHAIN_ID}
    `;
    const r = rows[0];
    if (r === undefined) return null;
    return {
      protocol: (r.protocol === "v4" ? "v4" : "v3") as "v3" | "v4",
      token: hex(r.token_address),
      name: r.name,
      symbol: r.symbol,
      creator: hex(r.creator),
      pairToken: hex(r.pair_token),
      pool: hex(r.pool_address),
      positionId: r.position_id === null ? 0n : BigInt(r.position_id),
      priceE18: BigInt(r.price_usd_e18 ?? "0"),
      marketCapUnits: BigInt(r.market_cap_usd_e6 ?? "0"),
      quoteBalance: BigInt(r.quote_balance ?? "0"),
      graduated: r.graduated,
      mode: r.mode,
      launchTime: r.launch_time,
      holderCount: r.holder_count,
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
      SELECT ts.token_address, ts.volume_24h_usd_e6, ts.change_24h_bps, ts.buy_count, ts.sell_count
      FROM token_stats ts
      JOIN tokens t ON t.token_address = ts.token_address AND t.chain_id = ${CHAIN_ID}
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
      WHERE chain_id = ${CHAIN_ID} AND block_time > now() - make_interval(hours => ${hours})
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
  if (!(await reachable())) return null;
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
        WHERE s.chain_id = ${CHAIN_ID}
        ORDER BY s.block_time DESC, s.log_index DESC
        LIMIT ${limit}
      )
      UNION ALL
      (
        SELECT 'launch', token_address, symbol, '0', launch_block::text, launch_time, launch_tx_hash
        FROM tokens
        WHERE chain_id = ${CHAIN_ID}
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
  if (!(await reachable())) return null;
  const sql = getDb();
  if (sql === null) return null;
  try {
    const rows = await sql<{ vol: string | null; trades: string; launches: string; grad: string }[]>`
      SELECT
        (SELECT COALESCE(SUM(volume_usd_e6), 0)::text FROM swaps WHERE chain_id = ${CHAIN_ID})  AS vol,
        (SELECT COUNT(*)::text FROM swaps WHERE chain_id = ${CHAIN_ID})                         AS trades,
        (SELECT COUNT(*)::text FROM tokens WHERE chain_id = ${CHAIN_ID})                        AS launches,
        (SELECT COUNT(*)::text FROM tokens WHERE chain_id = ${CHAIN_ID} AND graduated)          AS grad
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

export interface DailyPoint {
  /** UTC midnight that starts the day. */
  readonly day: Date;
  readonly volumeUnits: bigint;
  readonly swaps: number;
  /** False for today, which is still filling and must not be read as a drop. */
  readonly complete: boolean;
}

/**
 * Daily volume and swap count, oldest first, with no gaps.
 *
 * Days with no trading are emitted as zeroes rather than omitted: a bar chart
 * that silently drops empty days compresses the time axis and makes a quiet
 * week look continuously busy.
 *
 * Today is included but marked incomplete. A partial day plotted like a whole
 * one reads as a collapse in volume every single morning.
 */
export async function indexedDaily(days: number): Promise<DailyPoint[] | null> {
  if (!(await reachable())) return null;
  const sql = getDb();
  if (sql === null) return null;
  const span = Math.max(1, Math.min(Math.floor(days), 365));
  try {
    const rows = await sql<{ day: Date; vol: string | null; n: string }[]>`
      SELECT date_trunc('day', block_time) AS day,
             COALESCE(SUM(volume_usd_e6), 0)::text AS vol,
             COUNT(*)::text AS n
      FROM swaps
      WHERE chain_id = ${CHAIN_ID}
        AND block_time >= date_trunc('day', now() at time zone 'utc') - make_interval(days => ${span - 1})
      GROUP BY 1
      ORDER BY 1 ASC
    `;
    const byDay = new Map<number, { vol: bigint; n: number }>();
    for (const r of rows) {
      byDay.set(new Date(r.day).setUTCHours(0, 0, 0, 0), { vol: BigInt(r.vol ?? "0"), n: Number(r.n) });
    }
    const todayUtc = new Date().setUTCHours(0, 0, 0, 0);
    const out: DailyPoint[] = [];
    for (let i = span - 1; i >= 0; i--) {
      const key = todayUtc - i * 86_400_000;
      const hit = byDay.get(key);
      out.push({
        day: new Date(key),
        volumeUnits: hit?.vol ?? 0n,
        swaps: hit?.n ?? 0,
        complete: key !== todayUtc,
      });
    }
    return out;
  } catch {
    return null;
  }
}

export interface BurnedTotals {
  /** Protocol tokens bought back and burned, summed across Arcane launches. */
  readonly tokensBurned: bigint;
  /** Value of those tokens at each launch's current price, in USD micro-units. */
  readonly valueUnits: bigint;
  readonly launches: number;
}

/**
 * What Arcane mode has taken out of circulation.
 *
 * Valued at the current price, which is a snapshot rather than what the burns
 * cost at the time. Burned tokens are still counted in total supply and in the
 * market caps shown elsewhere, so this is not netted off them.
 */
export async function indexedBurned(): Promise<BurnedTotals | null> {
  if (!(await reachable())) return null;
  const sql = getDb();
  if (sql === null) return null;
  try {
    const rows = await sql<{ burned: string | null; value: string | null; n: string }[]>`
      SELECT COALESCE(SUM(s.tokens_burned), 0)::text AS burned,
             -- tokens_burned is 1e18-scaled and price_usd_e18 is USD per whole
             -- token, also 1e18. Their product is 1e36; 1e30 brings it to the
             -- 6-decimal micro-units every USD figure here uses.
             -- trunc, because NUMERIC division leaves a fractional part and
             -- BigInt() throws on a string carrying a decimal point.
             trunc(COALESCE(SUM(s.tokens_burned * s.price_usd_e18 / 1000000000000000000000000000000), 0))::text AS value,
             COUNT(*) FILTER (WHERE s.tokens_burned > 0)::text AS n
      FROM token_stats s
      JOIN tokens t ON t.token_address = s.token_address
      WHERE t.chain_id = ${CHAIN_ID}
    `;
    const r = rows[0];
    if (r === undefined) return null;
    return {
      tokensBurned: BigInt(r.burned ?? "0"),
      valueUnits: BigInt(r.value ?? "0"),
      launches: Number(r.n),
    };
  } catch {
    return null;
  }
}
