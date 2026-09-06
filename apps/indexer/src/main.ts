import pino from "pino";
import {
  createPublicClient,
  defineChain,
  fallback,
  http,
  parseAbiItem,
  type Hex,
  type PublicClient,
} from "viem";
import { createDatabase, runMigrations, type Sql } from "@arch/database";
import { priceUsdE18 } from "./price.js";

/**
 * Arc launch + swap indexer.
 *
 * Ingests Launched events (the token registry) and Swap events (trades) into
 * Postgres, computes USD price with exact bigint math for both token orderings,
 * aggregates OHLCV candles, and tracks graduation. Cursors store a block hash so
 * a reorg is detected and the affected range re-scanned. Runs continuously.
 *
 * The point of this process is that the website never reads the chain. Arc's
 * public RPC costs ~420ms per call no matter how small the request, so a page
 * that makes twenty calls can never be fast. Here that latency is paid once, in
 * the background, and every page load becomes a Postgres query.
 *
 * Three things matter for keeping it cheap:
 *
 *   · Swaps are read for ALL pools in one getLogs per block range, not one walk
 *     per token. With 20 tokens over a 6.7M-block history that is the difference
 *     between ~750 requests and ~15,000.
 *   · Block timestamps are cached per block. Fetching one per swap turned a
 *     single log into a second round trip.
 *   · Chunks are sized to Arc's real getLogs ceiling (~10k blocks), measured,
 *     rather than a conservative guess.
 */

const log = pino({ level: process.env["LOG_LEVEL"] ?? "info", name: "arch-indexer" });

const launchedEvent = parseAbiItem(
  "event Launched(address indexed token, address indexed creator, address pairToken, address pool, uint256 positionId, string metadataUri)",
);
const swapEvent = parseAbiItem(
  "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)",
);

const CANDLE_INTERVALS = [60, 300, 900, 3600, 14400, 86400];

/** Fixed 1e9-token supply, expressed so priceE18 * this / 1e18 lands in
 *  6-decimal USD units. Mirrors marketCapUsdUnits() in price.ts. */
const SUPPLY_E18_TO_E6 = 10n ** 15n;

/** Arc rejects a getLogs range much above 10k blocks. Measured, with headroom. */
const CHUNK = 9_000n;
/** Politeness between chunks while backfilling; the node drops large bursts. */
const CHUNK_DELAY_MS = 120;
/** At ~0.506s blocks this is ~24 blocks of lag at the tip. */
const POLL_MS = 12_000;
/** Stay behind the tip so a one-block reorg does not need rewinding. */
const CONFIRMATIONS = 2n;
/** Arc drops requests out of a large parallel burst; keep waves small. */
const BLOCK_FETCH_CONCURRENCY = 6;
/** Publish progress this often mid-walk. A 6.7M-block backfill is one very long
 *  cycle, and without this there is no way to see how far along it is. */
const HEALTH_EVERY_CHUNKS = 40;

/** Every factory generation. Tokens are never dropped because of an upgrade. */
const DEFAULT_FACTORIES = [
  "0x8e5732B520a318251a702a680AA7F123fb92AF52", // v4 — launch modes
  "0xE2aA88806872C2a02A4ab439584d457002983600", // v3 — fee recipient
  "0xA024664AD5d30F3c0b18b931DdB6f64A96DE8ED3", // v2 — SwapRouter02 fix
  "0x1d65ab4cDCDdA6f38A9c93a24EF64bE8905e19d5", // v1 — original
] as const;

/** Block the oldest factory was deployed in, found by binary search. Scanning
 *  from genesis would mean 19M pointless blocks. */
const DEFAULT_START_BLOCK = 12_775_070n;

/** Records each launch's fee mode. Same address the website reads. */
const DEFAULT_MODE_DISTRIBUTOR = "0x7c148B6a581E32CcB6ffF7Bd59AF4250d5ec1eBc";

/** 9,000 USDC, at Arc USDC's 6 decimals. */
const DEFAULT_GRADUATION_UNITS = 9_000_000_000n;

const arcChain = defineChain({
  id: 5042,
  name: "Arc",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.arc-scan.org"] } },
  contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } },
});

interface IndexerConfig {
  readonly arc: PublicClient;
  readonly sql: Sql;
  readonly factories: readonly Hex[];
  readonly graduationUnits: bigint;
  readonly chainId: number;
  readonly startBlock: bigint;
  readonly modeDistributor: Hex;
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (v === undefined || v.length === 0) throw new Error(`${name} is required`);
  return v;
}

function envList(name: string, fallbackValue: readonly string[]): Hex[] {
  const raw = process.env[name];
  const parsed = (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^0x[0-9a-fA-F]{40}$/.test(s));
  return (parsed.length > 0 ? parsed : [...fallbackValue]) as Hex[];
}

function addr(a: string): Buffer {
  return Buffer.from(a.slice(2), "hex");
}

/** 32-byte hash as bytea. Separate from addr() only for readability at call sites. */
function addr32(h: string): Buffer {
  return Buffer.from(h.slice(2), "hex");
}

/** One row of `swaps`, shaped for a bulk insert. Column names must match. */
interface SwapRow {
  chain_id: number;
  tx_hash: Buffer;
  log_index: number;
  pool_address: Buffer;
  token_address: Buffer;
  block_number: string;
  block_hash: Buffer;
  block_time: Date;
  sender: Buffer;
  recipient: Buffer;
  amount_token: string;
  amount_quote: string;
  sqrt_price_x96: string;
  liquidity: string;
  tick: number;
  is_buy: boolean;
  price_usd_e18: string;
  volume_usd_e6: string;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ cursors */

async function getCursor(sql: Sql, chainId: number, stream: string): Promise<bigint | null> {
  const rows = await sql<{ block_number: string }[]>`
    SELECT block_number FROM indexer_cursors WHERE chain_id = ${chainId} AND stream = ${stream}
  `;
  return rows[0] !== undefined ? BigInt(rows[0].block_number) : null;
}

async function setCursor(sql: Sql, chainId: number, stream: string, block: bigint, hash: Hex): Promise<void> {
  await sql`
    INSERT INTO indexer_cursors (chain_id, stream, block_number, block_hash, updated_at)
    VALUES (${chainId}, ${stream}, ${block.toString()}, ${Buffer.from(hash.slice(2), "hex")}, now())
    ON CONFLICT (chain_id, stream)
    DO UPDATE SET block_number = EXCLUDED.block_number, block_hash = EXCLUDED.block_hash, updated_at = now()
  `;
}

/** How far to step back when the chain disowns a block we already consumed. */
const REORG_REWIND = 128n;

/**
 * Rewind a stream if the chain no longer agrees about its last block.
 *
 * The cursor records the hash of the block it stopped at. If refetching that
 * height returns a different hash, the tail of what we ingested belongs to an
 * orphaned branch. Every write in this file is an upsert keyed by chain data,
 * so the fix is simply to move the cursor back and let the normal walk redo the
 * range — with the orphaned swaps deleted first, since a reorged-out trade would
 * otherwise linger forever behind its ON CONFLICT DO NOTHING.
 *
 * The comment in the first version of this file claimed to do this. It stored
 * the hash and never compared it.
 */
async function rewindIfReorged(cfg: IndexerConfig, stream: string): Promise<void> {
  const { sql, arc, chainId } = cfg;
  const rows = await sql<{ block_number: string; block_hash: Buffer | null }[]>`
    SELECT block_number, block_hash FROM indexer_cursors WHERE chain_id = ${chainId} AND stream = ${stream}
  `;
  const row = rows[0];
  if (row === undefined || row.block_hash === null) return;

  const at = BigInt(row.block_number);
  const onChain = await arc.getBlock({ blockNumber: at }).catch(() => null);
  if (onChain === null || onChain.hash === null) return;
  if (onChain.hash.slice(2).toLowerCase() === row.block_hash.toString("hex").toLowerCase()) return;

  const to = at > REORG_REWIND ? at - REORG_REWIND : cfg.startBlock;
  log.warn({ stream, from: at.toString(), to: to.toString() }, "reorg detected — rewinding");
  const orphanDay = await sql<{ day: Date | null }[]>`
    SELECT date_trunc('day', MIN(block_time)) AS day
    FROM swaps WHERE chain_id = ${chainId} AND block_number > ${to.toString()}
  `;
  const day = orphanDay[0]?.day ?? null;
  await sql`
    DELETE FROM swaps WHERE chain_id = ${chainId} AND block_number > ${to.toString()}
  `;
  // Buckets that the orphaned trades were the only contents of must disappear,
  // which a recompute alone would not do.
  if (day !== null) {
    await sql`DELETE FROM candles WHERE bucket_start >= ${day}`;
    await refreshCandles(sql, day);
  }
  await sql`
    UPDATE indexer_cursors SET block_number = ${to.toString()}
    WHERE chain_id = ${chainId} AND stream = ${stream}
  `;
}

/* ------------------------------------------------------- block time caching */

/**
 * Swaps arrive in clusters within a handful of blocks, and the schema needs a
 * timestamp and hash per row. Fetching a block per log made every trade cost an
 * extra round trip; this fetches each block once per cycle.
 */
class BlockCache {
  private readonly cache = new Map<string, { time: Date; hash: Hex }>();

  constructor(private readonly arc: PublicClient) {}

  async get(blockNumber: bigint): Promise<{ time: Date; hash: Hex }> {
    const key = blockNumber.toString();
    const hit = this.cache.get(key);
    if (hit !== undefined) return hit;
    const block = await this.arc.getBlock({ blockNumber });
    const value = { time: new Date(Number(block.timestamp) * 1000), hash: (block.hash ?? "0x") as Hex };
    this.cache.set(key, value);
    return value;
  }

  /**
   * Warm several blocks at once, so a chunk's logs resolve in one round.
   *
   * Bounded, because Arc's public node quietly drops requests from a large
   * parallel burst — measured at 40 in flight, only 22 came back. A dropped
   * block here would be refetched serially by get(), which is exactly the cost
   * this cache exists to avoid.
   */
  async warm(blockNumbers: readonly bigint[]): Promise<void> {
    const missing = [...new Set(blockNumbers.map((b) => b.toString()))].filter((k) => !this.cache.has(k));
    for (let i = 0; i < missing.length; i += BLOCK_FETCH_CONCURRENCY) {
      const slice = missing.slice(i, i + BLOCK_FETCH_CONCURRENCY);
      await Promise.all(slice.map((k) => this.get(BigInt(k)).catch(() => undefined)));
    }
  }

  /** Keep memory bounded on a long-running process. */
  prune(): void {
    if (this.cache.size < 5_000) return;
    this.cache.clear();
  }
}

/* ----------------------------------------------------------------- launches */

const ERC20_NAME = [
  { type: "function", name: "name", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
] as const;
const ERC20_SYMBOL = [
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
] as const;
const MODE_DISTRIBUTOR = [
  { type: "function", name: "modeSet", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "modeOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint8" }] },
] as const;

/**
 * Fee mode: 0 standard, 1 divium, 2 arcane; null for launches that predate the
 * distributor. Immutable once set, so it is read exactly once, at index time —
 * the website used to make both of these calls per token on every page load.
 */
async function readMode(arc: PublicClient, distributor: Hex, token: Hex): Promise<number | null> {
  const isSet = await arc
    .readContract({ address: distributor, abi: MODE_DISTRIBUTOR, functionName: "modeSet", args: [token] })
    .catch(() => false);
  if (isSet !== true) return null;
  const m = await arc
    .readContract({ address: distributor, abi: MODE_DISTRIBUTOR, functionName: "modeOf", args: [token] })
    .catch(() => null);
  return m === null ? null : Number(m);
}

/**
 * All factory generations, one walk.
 *
 * getLogs takes a list of addresses, so every generation of the launchpad is
 * read in the same request under a single cursor. Walking them one at a time
 * multiplied a 6.7M-block backfill by four for no extra information.
 */
async function indexLaunches(cfg: IndexerConfig, blocks: BlockCache): Promise<void> {
  const { arc, sql, chainId } = cfg;
  const tip = (await arc.getBlockNumber()) - CONFIRMATIONS;
  const stream = "launches:all";
  const from = (await getCursor(sql, chainId, stream)) ?? cfg.startBlock;
  if (from > tip) return;

  let chunksDone = 0;
  for (let start = from; start <= tip; start += CHUNK) {
    const end = start + CHUNK - 1n < tip ? start + CHUNK - 1n : tip;
    const logs = await arc
      .getLogs({ address: [...cfg.factories], event: launchedEvent, fromBlock: start, toBlock: end })
      .catch((err: unknown) => {
        log.warn({ err, start: start.toString(), end: end.toString() }, "launch chunk failed");
        return null;
      });
    // Stop the walk rather than skipping the range. Advancing the cursor over a
    // failed chunk loses those launches permanently — the cursor never comes
    // back, so nothing would ever re-read them.
    if (logs === null) break;

    if (logs.length > 0) {
      await blocks.warm(logs.map((l) => l.blockNumber ?? end));

      // name/symbol for the whole chunk in one go: the client batches these
      // through Multicall3, so a chunk full of launches still costs one request.
      const named = await Promise.all(
        logs.map(async (l) => {
          const token = l.args.token;
          if (token === undefined) return { name: "", symbol: "", mode: null };
          const [name, symbol, mode] = await Promise.all([
            arc.readContract({ address: token, abi: ERC20_NAME, functionName: "name" }).catch(() => ""),
            arc.readContract({ address: token, abi: ERC20_SYMBOL, functionName: "symbol" }).catch(() => ""),
            readMode(arc, cfg.modeDistributor, token),
          ]);
          return { name, symbol, mode };
        }),
      );

      for (const [i, l] of logs.entries()) {
        const token = l.args.token;
        if (token === undefined || l.transactionHash === null) continue;
        const { time } = await blocks.get(l.blockNumber ?? end);
        const pairToken = l.args.pairToken ?? "0x";
        const meta = named[i] ?? { name: "", symbol: "", mode: null };

        await sql`
          INSERT INTO tokens (
            token_address, chain_id, name, symbol, decimals, creator, pair_token,
            pool_address, position_id, token_is_token0, metadata_uri,
            launch_block, launch_tx_hash, launch_time, mode
          ) VALUES (
            ${addr(token)}, ${chainId}, ${meta.name}, ${meta.symbol}, 18,
            ${addr(l.args.creator ?? "0x")}, ${addr(pairToken)},
            ${addr(l.args.pool ?? "0x")}, ${(l.args.positionId ?? 0n).toString()},
            ${token.toLowerCase() < pairToken.toLowerCase()}, ${l.args.metadataUri ?? ""},
            ${(l.blockNumber ?? end).toString()}, ${addr(l.transactionHash)}, ${time}, ${meta.mode}
          )
          ON CONFLICT (token_address) DO UPDATE SET
            name = EXCLUDED.name, symbol = EXCLUDED.symbol, mode = EXCLUDED.mode
        `;
        await sql`
          INSERT INTO token_stats (token_address) VALUES (${addr(token)})
          ON CONFLICT (token_address) DO NOTHING
        `;
        log.info({ token, name: meta.name, symbol: meta.symbol }, "indexed launch");
      }
    }

    const endBlock = await blocks.get(end);
    await setCursor(sql, chainId, stream, end, endBlock.hash);
    if (++chunksDone % HEALTH_EVERY_CHUNKS === 0) await publishHealth(cfg, tip + CONFIRMATIONS);
    if (end < tip) await sleep(CHUNK_DELAY_MS);
  }
}

/* -------------------------------------------------------------------- swaps */

interface PoolRow {
  readonly token_address: Buffer;
  readonly pool_address: Buffer;
  readonly token_is_token0: boolean;
  readonly pair_token: Buffer;
}

/**
 * All pools, one walk.
 *
 * Every launch pool is queried in a single getLogs per range under one shared
 * cursor. Walking per token multiplied the whole backfill by the number of
 * tokens for no benefit — the node returns them together just as happily.
 */
async function indexSwaps(cfg: IndexerConfig, blocks: BlockCache): Promise<void> {
  const { arc, sql, chainId } = cfg;
  const pools = await sql<PoolRow[]>`
    SELECT token_address, pool_address, token_is_token0, pair_token
    FROM tokens WHERE chain_id = ${chainId}
  `;
  if (pools.length === 0) return;

  const byPool = new Map(
    pools.map((p) => [`0x${p.pool_address.toString("hex")}`.toLowerCase(), p]),
  );
  const addresses = pools.map((p) => `0x${p.pool_address.toString("hex")}` as Hex);

  const stream = "swaps:all";
  const head = (await arc.getBlockNumber()) - CONFIRMATIONS;

  // Never scan past where launches have been read.
  //
  // The pool list above is whatever the tokens table knows right now. If a
  // launch chunk failed and stalled its cursor while this one ran ahead, a pool
  // discovered later would already be behind the swap cursor, and its early
  // trades would never be read — a permanent hole that nothing retries. Holding
  // this walk at the launch frontier makes that impossible.
  const launchesAt = (await getCursor(sql, chainId, "launches:all")) ?? cfg.startBlock;
  const tip = launchesAt < head ? launchesAt : head;

  const from = (await getCursor(sql, chainId, stream)) ?? cfg.startBlock;
  if (from > tip) return;

  let chunksDone = 0;
  for (let start = from; start <= tip; start += CHUNK) {
    const end = start + CHUNK - 1n < tip ? start + CHUNK - 1n : tip;
    const logs = await arc
      .getLogs({ address: addresses, event: swapEvent, fromBlock: start, toBlock: end })
      .catch((err: unknown) => {
        log.warn({ err, start: start.toString(), end: end.toString() }, "swap chunk failed");
        return null;
      });
    // As above: a skipped range is a permanent hole in the trade history.
    if (logs === null) break;

    if (logs.length > 0) {
      await blocks.warm(logs.map((l) => l.blockNumber ?? end));
      log.info({ count: logs.length, start: start.toString(), end: end.toString() }, "swaps in range");
    }

    const rows: SwapRow[] = [];
    for (const l of logs) {
      const pool = byPool.get(l.address.toLowerCase());
      if (pool === undefined) continue;
      if (l.transactionHash === null || l.logIndex === null || l.args.sqrtPriceX96 === undefined) continue;

      const { time, hash } = await blocks.get(l.blockNumber ?? end);
      const amount0 = l.args.amount0 ?? 0n;
      const amount1 = l.args.amount1 ?? 0n;
      const quoteDelta = pool.token_is_token0 ? amount1 : amount0;
      const tokenDelta = pool.token_is_token0 ? amount0 : amount1;
      const volumeUnits = quoteDelta < 0n ? -quoteDelta : quoteDelta;
      const absToken = tokenDelta < 0n ? -tokenDelta : tokenDelta;

      rows.push({
        chain_id: chainId,
        tx_hash: addr32(l.transactionHash),
        log_index: l.logIndex,
        pool_address: pool.pool_address,
        token_address: pool.token_address,
        block_number: (l.blockNumber ?? end).toString(),
        block_hash: addr32(hash),
        block_time: time,
        sender: addr(l.args.sender ?? "0x"),
        recipient: addr(l.args.recipient ?? "0x"),
        amount_token: absToken.toString(),
        amount_quote: volumeUnits.toString(),
        sqrt_price_x96: l.args.sqrtPriceX96.toString(),
        liquidity: (l.args.liquidity ?? 0n).toString(),
        tick: l.args.tick ?? 0,
        // A positive quote delta means the pool received the quote asset, so the
        // user was buying the launched token.
        is_buy: quoteDelta > 0n,
        price_usd_e18: priceUsdE18(l.args.sqrtPriceX96, pool.token_is_token0).toString(),
        volume_usd_e6: volumeUnits.toString(),
      });
    }

    if (rows.length > 0) {
      // One statement per chunk rather than per trade. The database is in
      // us-east-2 and the indexer is not, so a round trip costs more than the
      // whole rest of the loop; the old path spent eight of them on every
      // single swap.
      await sql`
        INSERT INTO swaps ${sql(rows as unknown as Record<string, unknown>[])}
        ON CONFLICT (tx_hash, log_index) DO NOTHING
      `;
      const earliest = rows.reduce((a, r) => (r.block_time < a ? r.block_time : a), rows[0]!.block_time);
      await refreshCandles(sql, earliest);
    }

    const endBlock = await blocks.get(end);
    await setCursor(sql, chainId, stream, end, endBlock.hash);
    if (++chunksDone % HEALTH_EVERY_CHUNKS === 0) await publishHealth(cfg, head);
    if (end < tip) await sleep(CHUNK_DELAY_MS);
  }
}

/* ------------------------------------------------- liquidity + graduation */

/**
 * Pool balances change with every trade but are not in the Swap event, so they
 * are refreshed once per cycle via multicall rather than per swap.
 */
async function refreshPools(cfg: IndexerConfig): Promise<void> {
  const { arc, sql, chainId } = cfg;
  const pools = await sql<PoolRow[]>`
    SELECT token_address, pool_address, token_is_token0, pair_token
    FROM tokens WHERE chain_id = ${chainId}
  `;
  const balanceAbi = [
    { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  ] as const;

  await Promise.all(
    pools.map(async (p) => {
      const quote = `0x${p.pair_token.toString("hex")}` as Hex;
      const poolHex = `0x${p.pool_address.toString("hex")}` as Hex;
      const balance = await arc
        .readContract({ address: quote, abi: balanceAbi, functionName: "balanceOf", args: [poolHex] })
        .catch(() => null);
      if (balance === null) return;
      await sql`
        UPDATE token_stats SET quote_balance = ${balance.toString()} WHERE token_address = ${p.token_address}
      `;
      if (balance >= cfg.graduationUnits) {
        await sql`
          UPDATE tokens SET graduated = true, graduated_at = now()
          WHERE token_address = ${p.token_address} AND graduated = false
        `;
      }
    }),
  );
}

/**
 * Recompute every OHLCV bucket touched at or after `since`, straight from the
 * swaps table.
 *
 * Candles used to be maintained incrementally: six upserts per trade, each
 * adding to the running volume. That is six extra round trips per swap, and it
 * is only correct while no range is ever walked twice — re-scan a chunk after a
 * restart and the volume silently doubles. Deriving them makes candles a pure
 * function of swaps, so re-scanning is free and a rewind needs no special case.
 *
 * `since` is floored to a day so the widest interval's bucket is always covered
 * in full; aggregating from a mid-bucket cut would write a partial candle over
 * a complete one.
 */
async function refreshCandles(sql: Sql, since: Date): Promise<void> {
  await sql`
    INSERT INTO candles (
      token_address, interval_seconds, bucket_start,
      open_usd_e18, high_usd_e18, low_usd_e18, close_usd_e18, volume_usd_e6, trade_count
    )
    SELECT
      s.token_address,
      i.secs,
      to_timestamp(floor(extract(epoch FROM s.block_time) / i.secs) * i.secs),
      (ARRAY_AGG(s.price_usd_e18 ORDER BY s.block_number, s.log_index))[1],
      MAX(s.price_usd_e18),
      MIN(s.price_usd_e18),
      (ARRAY_AGG(s.price_usd_e18 ORDER BY s.block_number DESC, s.log_index DESC))[1],
      SUM(s.volume_usd_e6),
      COUNT(*)
    FROM swaps s
    CROSS JOIN unnest(${sql.array(CANDLE_INTERVALS)}::int[]) AS i(secs)
    WHERE s.block_time >= date_trunc('day', ${since}::timestamptz)
    GROUP BY 1, 2, 3
    ON CONFLICT (token_address, interval_seconds, bucket_start) DO UPDATE SET
      open_usd_e18  = EXCLUDED.open_usd_e18,
      high_usd_e18  = EXCLUDED.high_usd_e18,
      low_usd_e18   = EXCLUDED.low_usd_e18,
      close_usd_e18 = EXCLUDED.close_usd_e18,
      volume_usd_e6 = EXCLUDED.volume_usd_e6,
      trade_count   = EXCLUDED.trade_count
  `;
}

/**
 * Fill in the fee mode for tokens indexed before this ran, once per start.
 *
 * New launches get their mode read inline, but rows already in the table were
 * written by an earlier version and their cursor has long since moved past. A
 * NULL mode is also the correct, permanent answer for launches that predate the
 * distributor, so this cannot run every cycle — it would re-ask the chain about
 * the same tokens forever. Once at startup is enough: mode never changes.
 */
async function backfillModes(cfg: IndexerConfig): Promise<void> {
  const { sql, chainId } = cfg;
  const rows = await sql<{ token_address: Buffer }[]>`
    SELECT token_address FROM tokens WHERE chain_id = ${chainId} AND mode IS NULL
  `;
  if (rows.length === 0) return;
  let filled = 0;
  for (const r of rows) {
    const mode = await readMode(cfg.arc, cfg.modeDistributor, `0x${r.token_address.toString("hex")}` as Hex);
    if (mode === null) continue;
    await sql`UPDATE tokens SET mode = ${mode} WHERE token_address = ${r.token_address}`;
    filled += 1;
  }
  log.info({ checked: rows.length, filled }, "mode backfill");
}

/* ------------------------------------------------------------------ rollups */

/**
 * Recompute every derived market figure from the swaps table.
 *
 * These are the numbers Explore sorts and filters on, and the reason a page
 * load currently costs eighteen getLogs calls. Deriving them in one statement
 * means they are always consistent with the raw trades, cost no RPC at all, and
 * survive a re-scan — whereas the counters they replace drifted upward every
 * time a range was walked twice.
 *
 * 24h change uses the first price in the window as the baseline. For a token
 * younger than a day that is the only honest reference point, and it is what
 * every other pad shows.
 */
async function rollup(cfg: IndexerConfig): Promise<void> {
  // Latest price per token, from its most recent trade.
  await cfg.sql`
    UPDATE token_stats ts SET
      price_quote_x96   = l.sqrt_price_x96,
      price_usd_e18     = l.price_usd_e18,
      market_cap_usd_e6 = l.price_usd_e18 * ${SUPPLY_E18_TO_E6.toString()} / 1000000000000000000,
      liquidity         = l.liquidity,
      updated_at        = now()
    FROM (
      SELECT DISTINCT ON (token_address)
             token_address, sqrt_price_x96, price_usd_e18, liquidity
      FROM swaps ORDER BY token_address, block_number DESC, log_index DESC
    ) l
    WHERE ts.token_address = l.token_address
  `;

  await cfg.sql`
    UPDATE token_stats ts SET
      buy_count = COALESCE(a.buys, 0),
      sell_count = COALESCE(a.sells, 0),
      volume_24h_usd_e6 = COALESCE(w.vol, 0),
      change_24h_bps = CASE
        WHEN w.first_price IS NULL OR w.first_price = 0 THEN NULL
        ELSE GREATEST(-1000000, LEAST(1000000,
          ((w.last_price - w.first_price) * 10000 / w.first_price)::bigint))
      END,
      updated_at = now()
    FROM tokens t
    LEFT JOIN (
      SELECT token_address,
             COUNT(*) FILTER (WHERE is_buy)     AS buys,
             COUNT(*) FILTER (WHERE NOT is_buy) AS sells
      FROM swaps GROUP BY token_address
    ) a ON a.token_address = t.token_address
    LEFT JOIN (
      SELECT token_address,
             SUM(volume_usd_e6) AS vol,
             (ARRAY_AGG(price_usd_e18 ORDER BY block_number, log_index))[1]           AS first_price,
             (ARRAY_AGG(price_usd_e18 ORDER BY block_number DESC, log_index DESC))[1] AS last_price
      FROM swaps
      WHERE block_time > now() - interval '24 hours'
      GROUP BY token_address
    ) w ON w.token_address = t.token_address
    WHERE ts.token_address = t.token_address
  `;
}

/**
 * Mirror launch metadata into the table the website already reads for logos.
 *
 * The site decodes a token's image out of the base64 metadataUri embedded in the
 * Launched event. It used to find that by scanning 400,000 blocks in a single
 * getLogs — a range Arc rejects outright, swallowed by a catch, which is why
 * logos and socials never appeared for anything. Writing it here means the
 * lookup becomes a primary-key read and is right for every token ever launched,
 * including the ones from before this table existed.
 */
async function mirrorMetadata(cfg: IndexerConfig): Promise<void> {
  const { sql, chainId } = cfg;
  await sql`
    CREATE TABLE IF NOT EXISTS token_metadata (
      token_address text PRIMARY KEY,
      metadata_uri  text NOT NULL,
      saved_at      timestamptz NOT NULL DEFAULT now()
    )
  `;
  await sql`
    INSERT INTO token_metadata (token_address, metadata_uri)
    SELECT '0x' || encode(token_address, 'hex'), metadata_uri
    FROM tokens
    WHERE chain_id = ${chainId} AND metadata_uri <> ''
    ON CONFLICT (token_address) DO UPDATE SET metadata_uri = EXCLUDED.metadata_uri
  `;
}

/**
 * Publish how far along the indexer is, so the website can decide whether to
 * trust it. A backfilling indexer writes just as often as a caught-up one, so
 * recency alone would hand the page a half-built table.
 */
async function publishHealth(cfg: IndexerConfig, tip: bigint): Promise<void> {
  const { sql, chainId } = cfg;
  const launches = (await getCursor(sql, chainId, "launches:all")) ?? 0n;
  const swaps = (await getCursor(sql, chainId, "swaps:all")) ?? 0n;
  await sql`
    INSERT INTO indexer_health (chain_id, tip_block, launches_block, swaps_block, updated_at)
    VALUES (${chainId}, ${tip.toString()}, ${launches.toString()}, ${swaps.toString()}, now())
    ON CONFLICT (chain_id) DO UPDATE SET
      tip_block = EXCLUDED.tip_block,
      launches_block = EXCLUDED.launches_block,
      swaps_block = EXCLUDED.swaps_block,
      updated_at = now()
  `;
  const behind = tip - (swaps < launches ? swaps : launches);
  log.info({ tip: tip.toString(), behind: behind.toString() }, "health");
}

/* --------------------------------------------------------------------- main */

async function main(): Promise<void> {
  const databaseUrl = requireEnv("DATABASE_URL");
  const sql = createDatabase({ url: databaseUrl });

  const rpcs = (process.env["ARC_RPC_URLS"] ?? "https://rpc.arc-scan.org")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const arc = createPublicClient({
    chain: arcChain,
    transport: fallback(rpcs.map((url) => http(url, { timeout: 20_000, retryCount: 1 }))),
    // Arc's RPC drops large bursts of individual calls; Multicall3 folds the
    // per-token reads into single requests.
    batch: { multicall: { wait: 16, batchSize: 512 } },
  });

  const cfg: IndexerConfig = {
    arc,
    sql,
    factories: envList("ARCH_LAUNCHPAD_FACTORIES", DEFAULT_FACTORIES),
    graduationUnits: BigInt(process.env["GRADUATION_QUOTE_UNITS"] ?? DEFAULT_GRADUATION_UNITS.toString()),
    chainId: await arc.getChainId(),
    startBlock: BigInt(process.env["INDEXER_START_BLOCK"] ?? DEFAULT_START_BLOCK.toString()),
    modeDistributor: (process.env["ARCH_MODE_DISTRIBUTOR_ADDRESS"] ?? DEFAULT_MODE_DISTRIBUTOR) as Hex,
  };

  const applied = await runMigrations(databaseUrl);
  log.info(
    {
      chainId: cfg.chainId,
      factories: cfg.factories.length,
      startBlock: cfg.startBlock.toString(),
      rpcs,
      migrations: applied,
    },
    "indexer starting",
  );

  const blocks = new BlockCache(arc);
  await backfillModes(cfg).catch((err: unknown) => log.warn({ err }, "mode backfill failed"));

  for (;;) {
    const began = Date.now();
    try {
      await rewindIfReorged(cfg, "swaps:all");
      await rewindIfReorged(cfg, "launches:all");
      await indexLaunches(cfg, blocks);
      await indexSwaps(cfg, blocks);
      await refreshPools(cfg);
      await rollup(cfg);
      await mirrorMetadata(cfg);
      await publishHealth(cfg, await arc.getBlockNumber());
      log.info({ ms: Date.now() - began }, "cycle complete");
    } catch (err) {
      log.error({ err }, "index cycle failed; retrying");
    }
    blocks.prune();
    await sleep(POLL_MS);
  }
}

main().catch((err: unknown) => {
  log.fatal({ err }, "indexer crashed");
  process.exit(1);
});
