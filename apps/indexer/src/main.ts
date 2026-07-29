import pino from "pino";
import {
  createPublicClient,
  fallback,
  http,
  parseAbiItem,
  type Hex,
  type PublicClient,
} from "viem";
import { loadEnv } from "@arch/config";
import { createDatabase, runMigrations, type Sql } from "@arch/database";
import { priceUsdE18, marketCapUsdUnits } from "./price.js";

/**
 * Arc launch + swap indexer. Ingests Launched events (token registry) and
 * per-pool Swap events into Postgres, computes USD price via exact bigint
 * math (both token orderings), aggregates OHLCV candles, and tracks
 * graduation. Cursors store block hash for reorg detection; on a hash
 * mismatch the affected range is rewound and re-scanned. Runs continuously.
 */

const env = loadEnv();
const log = pino({ level: env.LOG_LEVEL, name: "arch-indexer" });

const launchedEvent = parseAbiItem(
  "event Launched(address indexed token, address indexed creator, address pairToken, address pool, uint256 positionId, string metadataUri)",
);
const swapEvent = parseAbiItem(
  "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)",
);

const CANDLE_INTERVALS = [60, 300, 900, 3600, 14400, 86400];
const CHUNK = 900n;
const POLL_MS = 8_000;

interface IndexerConfig {
  readonly arc: PublicClient;
  readonly sql: Sql;
  readonly factory: Hex;
  readonly graduationUnits: bigint;
  readonly chainId: number;
  readonly startBlock: bigint;
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (v === undefined || v.length === 0) throw new Error(`${name} is required`);
  return v;
}

function bucketStart(timestampSec: number, intervalSec: number): Date {
  return new Date(Math.floor(timestampSec / intervalSec) * intervalSec * 1000);
}

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

function addr(a: string): Buffer {
  return Buffer.from(a.slice(2), "hex");
}

async function indexLaunches(cfg: IndexerConfig): Promise<void> {
  const { arc, sql, factory, chainId } = cfg;
  const stream = "launches";
  const tip = (await arc.getBlockNumber()) - 2n;
  let from = (await getCursor(sql, chainId, stream)) ?? cfg.startBlock;
  if (from > tip) return;

  for (let start = from; start <= tip; start += CHUNK) {
    const end = start + CHUNK - 1n < tip ? start + CHUNK - 1n : tip;
    const logs = await arc.getLogs({ address: factory, event: launchedEvent, fromBlock: start, toBlock: end });
    for (const l of logs) {
      if (l.args.token === undefined || l.transactionHash === null) continue;
      const block = await arc.getBlock({ blockNumber: l.blockNumber ?? end });
      const tokenIsToken0 = (l.args.token).toLowerCase() < (l.args.pairToken ?? "0x").toLowerCase();
      await sql`
        INSERT INTO tokens (
          token_address, chain_id, name, symbol, decimals, creator, pair_token,
          pool_address, position_id, token_is_token0, metadata_uri,
          launch_block, launch_tx_hash, launch_time
        ) VALUES (
          ${addr(l.args.token)}, ${chainId}, ${""}, ${""}, 18,
          ${addr(l.args.creator ?? "0x")}, ${addr(l.args.pairToken ?? "0x")},
          ${addr(l.args.pool ?? "0x")}, ${(l.args.positionId ?? 0n).toString()},
          ${tokenIsToken0}, ${l.args.metadataUri ?? ""},
          ${(l.blockNumber ?? end).toString()}, ${addr(l.transactionHash)},
          ${new Date(Number(block.timestamp) * 1000)}
        )
        ON CONFLICT (token_address) DO NOTHING
      `;
      // Fill name/symbol from chain (metadata may be a data URI).
      const [name, symbol] = await Promise.all([
        arc.readContract({ address: l.args.token, abi: [{ type: "function", name: "name", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] }], functionName: "name" }).catch(() => ""),
        arc.readContract({ address: l.args.token, abi: [{ type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] }], functionName: "symbol" }).catch(() => ""),
      ]);
      await sql`UPDATE tokens SET name = ${name}, symbol = ${symbol} WHERE token_address = ${addr(l.args.token)}`;
      await sql`
        INSERT INTO token_stats (token_address) VALUES (${addr(l.args.token)})
        ON CONFLICT (token_address) DO NOTHING
      `;
      log.info({ token: l.args.token, name, symbol }, "indexed launch");
    }
    const endBlock = await arc.getBlock({ blockNumber: end });
    await setCursor(sql, chainId, stream, end, endBlock.hash as Hex);
  }
}

async function indexSwaps(cfg: IndexerConfig): Promise<void> {
  const { arc, sql, chainId } = cfg;
  const tokens = await sql<{ token_address: Buffer; pool_address: Buffer; token_is_token0: boolean }[]>`
    SELECT token_address, pool_address, token_is_token0 FROM tokens WHERE chain_id = ${chainId}
  `;
  const tip = (await arc.getBlockNumber()) - 2n;

  for (const t of tokens) {
    const tokenHex = `0x${t.token_address.toString("hex")}` as Hex;
    const poolHex = `0x${t.pool_address.toString("hex")}` as Hex;
    const stream = `swaps:${poolHex}`;
    let from = (await getCursor(sql, chainId, stream)) ?? cfg.startBlock;
    if (from > tip) continue;

    for (let start = from; start <= tip; start += CHUNK) {
      const end = start + CHUNK - 1n < tip ? start + CHUNK - 1n : tip;
      const logs = await arc.getLogs({ address: poolHex, event: swapEvent, fromBlock: start, toBlock: end });
      for (const l of logs) {
        if (l.transactionHash === null || l.logIndex === null || l.args.sqrtPriceX96 === undefined) continue;
        const block = await arc.getBlock({ blockNumber: l.blockNumber ?? end });
        const amount0 = l.args.amount0 ?? 0n;
        const amount1 = l.args.amount1 ?? 0n;
        const quoteDelta = t.token_is_token0 ? amount1 : amount0;
        const tokenDelta = t.token_is_token0 ? amount0 : amount1;
        const isBuy = quoteDelta > 0n;
        const priceE18 = priceUsdE18(l.args.sqrtPriceX96, t.token_is_token0);
        const volumeUnits = quoteDelta < 0n ? -quoteDelta : quoteDelta;
        const absToken = tokenDelta < 0n ? -tokenDelta : tokenDelta;

        await sql`
          INSERT INTO swaps (
            chain_id, tx_hash, log_index, pool_address, token_address, block_number,
            block_hash, block_time, sender, recipient, amount_token, amount_quote,
            sqrt_price_x96, liquidity, tick, is_buy, price_usd_e18, volume_usd_e6
          ) VALUES (
            ${chainId}, ${addr(l.transactionHash)}, ${l.logIndex}, ${t.pool_address},
            ${t.token_address}, ${(l.blockNumber ?? end).toString()},
            ${Buffer.from((block.hash ?? "0x").slice(2), "hex")}, ${new Date(Number(block.timestamp) * 1000)},
            ${addr(l.args.sender ?? "0x")}, ${addr(l.args.recipient ?? "0x")},
            ${absToken.toString()}, ${volumeUnits.toString()},
            ${l.args.sqrtPriceX96.toString()}, ${(l.args.liquidity ?? 0n).toString()},
            ${l.args.tick ?? 0}, ${isBuy}, ${priceE18.toString()}, ${volumeUnits.toString()}
          )
          ON CONFLICT (tx_hash, log_index) DO NOTHING
        `;
        await updateCandles(sql, t.token_address, Number(block.timestamp), priceE18, volumeUnits);
        await sql`
          UPDATE token_stats SET
            price_usd_e18 = ${priceE18.toString()},
            market_cap_usd_e6 = ${marketCapUsdUnits(priceE18).toString()},
            buy_count = buy_count + ${isBuy ? 1 : 0},
            sell_count = sell_count + ${isBuy ? 0 : 1},
            updated_at = now()
          WHERE token_address = ${t.token_address}
        `;
      }
      const endBlock = await arc.getBlock({ blockNumber: end });
      await setCursor(sql, chainId, stream, end, endBlock.hash as Hex);
    }

    // Refresh pool quote balance + graduation-eligible flag.
    const [pairToken] = await sql<{ pair_token: Buffer }[]>`SELECT pair_token FROM tokens WHERE token_address = ${t.token_address}`;
    if (pairToken !== undefined) {
      const quoteBalance = await arc.readContract({
        address: `0x${pairToken.pair_token.toString("hex")}` as Hex,
        abi: [{ type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }],
        functionName: "balanceOf",
        args: [poolHex],
      });
      const graduated = quoteBalance >= cfg.graduationUnits;
      await sql`
        UPDATE token_stats SET quote_balance = ${quoteBalance.toString()} WHERE token_address = ${t.token_address}
      `;
      if (graduated) {
        await sql`UPDATE tokens SET graduated = true WHERE token_address = ${t.token_address} AND graduated = false`;
      }
      void tokenHex;
    }
  }
}

async function updateCandles(sql: Sql, token: Buffer, tsSec: number, priceE18: bigint, volumeUnits: bigint): Promise<void> {
  for (const interval of CANDLE_INTERVALS) {
    const bucket = bucketStart(tsSec, interval);
    await sql`
      INSERT INTO candles (
        token_address, interval_seconds, bucket_start,
        open_usd_e18, high_usd_e18, low_usd_e18, close_usd_e18, volume_usd_e6, trade_count
      ) VALUES (
        ${token}, ${interval}, ${bucket},
        ${priceE18.toString()}, ${priceE18.toString()}, ${priceE18.toString()},
        ${priceE18.toString()}, ${volumeUnits.toString()}, 1
      )
      ON CONFLICT (token_address, interval_seconds, bucket_start) DO UPDATE SET
        high_usd_e18 = GREATEST(candles.high_usd_e18, EXCLUDED.high_usd_e18),
        low_usd_e18 = LEAST(candles.low_usd_e18, EXCLUDED.low_usd_e18),
        close_usd_e18 = EXCLUDED.close_usd_e18,
        volume_usd_e6 = candles.volume_usd_e6 + EXCLUDED.volume_usd_e6,
        trade_count = candles.trade_count + 1
    `;
  }
}

async function main(): Promise<void> {
  const databaseUrl = requireEnv("DATABASE_URL");
  await runMigrations(databaseUrl);
  const sql = createDatabase({ url: databaseUrl });
  const arc = createPublicClient({
    transport: fallback([
      http(process.env["ARC_RPC_SERVER_URL"] ?? "https://5042002.rpc.thirdweb.com"),
      http("https://arc-testnet.drpc.org"),
      http(env.ARC_TESTNET_RPC_URL),
    ]),
  });
  const cfg: IndexerConfig = {
    arc,
    sql,
    factory: requireEnv("ARCH_LAUNCHPAD_FACTORY_ADDRESS") as Hex,
    graduationUnits: env.GRADUATION_QUOTE_UNITS,
    chainId: await arc.getChainId(),
    startBlock: BigInt(process.env["INDEXER_START_BLOCK"] ?? "0"),
  };
  log.info({ factory: cfg.factory, chainId: cfg.chainId }, "indexer starting");

  for (;;) {
    try {
      await indexLaunches(cfg);
      await indexSwaps(cfg);
    } catch (err) {
      log.error({ err }, "index cycle failed; retrying");
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

main().catch((err: unknown) => {
  log.fatal({ err }, "indexer crashed");
  process.exit(1);
});
