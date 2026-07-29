import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import pino from "pino";
import {
  createPublicClient,
  http,
  parseAbiItem,
  type Hex,
  type PublicClient,
} from "viem";
import { archBridgeArcAbi, archVaultBaseAbi } from "@arch/abis";
import { bridgeActionId, subtractBps, applyBps } from "@arch/sdk";
import { loadEnv, featureFlagsFromEnv, feeConfigFromEnv } from "@arch/config";
import { createDatabase, type Sql } from "@arch/database";

/**
 * Arch public REST API — bridge endpoints (Milestone 3).
 *
 * Chain-backed: quotes read live vault parameters, action statuses are proven
 * against the on-chain processed mappings, and address history is
 * reconstructed from events. A PostgreSQL cache layer (faster history, richer
 * states) plugs in behind the same routes without changing responses.
 */

const env = loadEnv();
const log = pino({ level: env.LOG_LEVEL, name: "arch-api" });
const flags = featureFlagsFromEnv(env);
const fees = feeConfigFromEnv(env);

const BASE_RPC = env.BASE_SEPOLIA_RPC_URL ?? "https://sepolia.base.org";
const ARC_RPC = env.ARC_TESTNET_RPC_URL;
const VAULT = process.env["ARCH_VAULT_BASE_ADDRESS"] as Hex | undefined;
const BRIDGE = process.env["ARCH_BRIDGE_ARC_ADDRESS"] as Hex | undefined;

const base = createPublicClient({ transport: http(BASE_RPC) });
const arc = createPublicClient({ transport: http(ARC_RPC) });

// Optional Postgres cache: token/candle/trade endpoints use it when present.
const DATABASE_URL = process.env["DATABASE_URL"];
const db: Sql | null = DATABASE_URL !== undefined ? createDatabase({ url: DATABASE_URL }) : null;

const AUSD = process.env["ARCH_USD_ADDRESS"] as Hex | undefined;
const ausdSupplyAbi = [
  { type: "function", name: "totalSupply", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;

const depositedEvent = parseAbiItem(
  "event Deposited(address indexed sender, address indexed arcRecipient, uint256 grossAmount, uint256 feeAmount, uint256 netAmount, uint256 nonce)",
);
const redeemedEvent = parseAbiItem(
  "event Redeemed(address indexed sender, address indexed baseRecipient, uint256 amount, uint256 nonce)",
);

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
  });
  res.end(JSON.stringify(body, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v)));
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  return text.length > 0 ? (JSON.parse(text) as unknown) : {};
}

async function getLogsChunked<T extends typeof depositedEvent | typeof redeemedEvent>(
  client: PublicClient,
  address: Hex,
  event: T,
  lookback: bigint,
  args?: Record<string, unknown>,
) {
  const tip = await client.getBlockNumber();
  const from = tip > lookback ? tip - lookback : 0n;
  const all = [];
  const step = 1_900n;
  for (let start = from; start <= tip; start += step) {
    const end = start + step - 1n < tip ? start + step - 1n : tip;
    all.push(
      ...(await client.getLogs({
        address,
        event,
        args: args as never,
        fromBlock: start,
        toBlock: end,
      })),
    );
  }
  return all;
}

// ------------------------------------------------------------------ handlers

async function handleQuote(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = (await readBody(req)) as { direction?: string; amount?: string };
  if (
    (body.direction !== "deposit" && body.direction !== "redeem") ||
    body.amount === undefined ||
    !/^[0-9]+$/.test(body.amount)
  ) {
    json(res, 400, { error: "expected { direction: 'deposit'|'redeem', amount: '<units>' }" });
    return;
  }
  const amount = BigInt(body.amount);

  if (body.direction === "redeem") {
    let minRedeem = 0n;
    if (BRIDGE !== undefined) {
      minRedeem = await arc.readContract({ address: BRIDGE, abi: archBridgeArcAbi, functionName: "minRedeem" });
    }
    json(res, 200, {
      direction: "redeem",
      grossAmount: amount,
      feeAmount: 0n,
      netAmount: amount,
      feeBps: 0n,
      minAmount: minRedeem,
      note: "Redemption is free and one-for-one.",
    });
    return;
  }

  // Deposit: read the live fee from the vault when deployed.
  let feeBps = fees.bridgeDepositFeeBps;
  let minAmount = env.BRIDGE_MIN_DEPOSIT_UNITS;
  let maxAmount = env.BRIDGE_MAX_DEPOSIT_UNITS;
  let source = "configuration_default";
  if (VAULT !== undefined) {
    [feeBps, minAmount, maxAmount] = await Promise.all([
      base.readContract({ address: VAULT, abi: archVaultBaseAbi, functionName: "feeBps" }),
      base.readContract({ address: VAULT, abi: archVaultBaseAbi, functionName: "minDeposit" }),
      base.readContract({ address: VAULT, abi: archVaultBaseAbi, functionName: "maxDeposit" }),
    ]);
    source = "onchain";
  }
  const feeAmount = applyBps(amount, feeBps);
  json(res, 200, {
    direction: "deposit",
    grossAmount: amount,
    feeAmount,
    netAmount: subtractBps(amount, feeBps),
    feeBps,
    minAmount,
    maxAmount,
    source,
  });
}

async function handleAction(res: ServerResponse, actionIdHex: string): Promise<void> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(actionIdHex)) {
    json(res, 400, { error: "actionId must be a 32-byte hex string" });
    return;
  }
  const actionId = actionIdHex as Hex;
  const [minted, released] = await Promise.all([
    BRIDGE !== undefined
      ? arc.readContract({ address: BRIDGE, abi: archBridgeArcAbi, functionName: "processedDeposits", args: [actionId] })
      : false,
    VAULT !== undefined
      ? base.readContract({ address: VAULT, abi: archVaultBaseAbi, functionName: "processedRedemptions", args: [actionId] })
      : false,
  ]);
  if (minted) {
    json(res, 200, {
      actionId,
      direction: "deposit",
      state: "completed",
      proof: "processedDeposits(actionId) == true on the Arc bridge contract",
    });
    return;
  }
  if (released) {
    json(res, 200, {
      actionId,
      direction: "redeem",
      state: "completed",
      proof: "processedRedemptions(actionId) == true on the Base vault contract",
    });
    return;
  }
  json(res, 200, {
    actionId,
    state: "source_confirmed_or_unknown",
    detail:
      "Not yet processed on the destination chain. If the source transaction is confirmed, the worker will process it after the confirmation depth.",
  });
}

async function handleAddress(res: ServerResponse, address: string): Promise<void> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    json(res, 400, { error: "invalid address" });
    return;
  }
  const account = address as Hex;
  const actions: unknown[] = [];

  if (VAULT !== undefined) {
    const deposits = await getLogsChunked(base, VAULT, depositedEvent, 40_000n, { sender: account });
    for (const d of deposits) {
      if (d.transactionHash === null || d.logIndex === null) continue;
      const actionId = bridgeActionId(d.transactionHash, BigInt(d.logIndex));
      const minted =
        BRIDGE !== undefined
          ? await arc.readContract({ address: BRIDGE, abi: archBridgeArcAbi, functionName: "processedDeposits", args: [actionId] })
          : false;
      actions.push({
        actionId,
        direction: "deposit",
        state: minted ? "completed" : "source_confirmed",
        sourceTxHash: d.transactionHash,
        grossAmount: d.args.grossAmount,
        feeAmount: d.args.feeAmount,
        netAmount: d.args.netAmount,
        recipient: d.args.arcRecipient,
        sourceExplorer: `https://sepolia.basescan.org/tx/${d.transactionHash}`,
      });
    }
  }

  if (BRIDGE !== undefined) {
    const redeems = await getLogsChunked(arc, BRIDGE, redeemedEvent, 100_000n, { sender: account });
    for (const r of redeems) {
      if (r.transactionHash === null || r.logIndex === null) continue;
      const actionId = bridgeActionId(r.transactionHash, BigInt(r.logIndex));
      const released =
        VAULT !== undefined
          ? await base.readContract({ address: VAULT, abi: archVaultBaseAbi, functionName: "processedRedemptions", args: [actionId] })
          : false;
      actions.push({
        actionId,
        direction: "redeem",
        state: released ? "completed" : "source_confirmed",
        sourceTxHash: r.transactionHash,
        amount: r.args.amount,
        recipient: r.args.baseRecipient,
        sourceExplorer: `https://testnet.arcscan.app/tx/${r.transactionHash}`,
      });
    }
  }

  json(res, 200, { address: account, actions });
}

// ------------------------------------------------------------- solvency + db

async function handleSolvency(res: ServerResponse): Promise<void> {
  if (VAULT === undefined || AUSD === undefined) {
    json(res, 503, { error: "bridge contracts not configured" });
    return;
  }
  const [reserve, supply] = await Promise.all([
    base.readContract({ address: VAULT, abi: archVaultBaseAbi, functionName: "totalReserve" }),
    arc.readContract({ address: AUSD, abi: ausdSupplyAbi, functionName: "totalSupply" }),
  ]);
  const solvent = reserve >= supply;
  json(res, 200, {
    reserveUnits: reserve,
    supplyUnits: supply,
    surplusUnits: reserve - supply,
    // Ratio in bps of reserve to supply (10000 = exactly backed).
    ratioBps: supply === 0n ? null : (reserve * 10_000n) / supply,
    solvent,
  });
}

function requireDb(res: ServerResponse): Sql | null {
  if (db === null) {
    json(res, 503, { error: "database not configured; token endpoints require the indexer" });
    return null;
  }
  return db;
}

function tokenRowToJson(r: Record<string, unknown>): Record<string, unknown> {
  return {
    token: `0x${(r["token_address"] as Buffer).toString("hex")}`,
    name: r["name"],
    symbol: r["symbol"],
    creator: `0x${(r["creator"] as Buffer).toString("hex")}`,
    pairToken: `0x${(r["pair_token"] as Buffer).toString("hex")}`,
    pool: `0x${(r["pool_address"] as Buffer).toString("hex")}`,
    priceUsdE18: r["price_usd_e18"] ?? null,
    marketCapUsdE6: r["market_cap_usd_e6"] ?? null,
    quoteBalanceUnits: r["quote_balance"] ?? null,
    buyCount: r["buy_count"] ?? 0,
    sellCount: r["sell_count"] ?? 0,
    graduated: r["graduated"] ?? false,
    launchTime: r["launch_time"],
  };
}

async function handleTokens(res: ServerResponse, url: string): Promise<void> {
  const sql = requireDb(res);
  if (sql === null) return;
  const params = new URL(url, "http://x").searchParams;
  const sort = params.get("sort") ?? "newest";
  const order =
    sort === "market_cap" ? sql`ts.market_cap_usd_e6 DESC NULLS LAST`
    : sort === "volume_24h" ? sql`ts.volume_24h_usd_e6 DESC NULLS LAST`
    : sort === "oldest" ? sql`t.launch_time ASC`
    : sql`t.launch_time DESC`;
  const rows = await sql<Record<string, unknown>[]>`
    SELECT t.*, ts.price_usd_e18, ts.market_cap_usd_e6, ts.quote_balance, ts.buy_count, ts.sell_count
    FROM tokens t LEFT JOIN token_stats ts USING (token_address)
    ${sort === "graduated" ? sql`WHERE t.graduated = true` : sql``}
    ORDER BY ${order} LIMIT 100
  `;
  json(res, 200, { tokens: rows.map(tokenRowToJson) });
}

async function handleTokenDetail(res: ServerResponse, token: string): Promise<void> {
  const sql = requireDb(res);
  if (sql === null) return;
  const rows = await sql<Record<string, unknown>[]>`
    SELECT t.*, ts.price_usd_e18, ts.market_cap_usd_e6, ts.quote_balance, ts.buy_count, ts.sell_count
    FROM tokens t LEFT JOIN token_stats ts USING (token_address)
    WHERE t.token_address = ${Buffer.from(token.slice(2), "hex")}
  `;
  if (rows[0] === undefined) {
    json(res, 404, { error: "token not found" });
    return;
  }
  json(res, 200, tokenRowToJson(rows[0]));
}

async function handleCandles(res: ServerResponse, token: string, url: string): Promise<void> {
  const sql = requireDb(res);
  if (sql === null) return;
  const intervalMap: Record<string, number> = { "1m": 60, "5m": 300, "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400 };
  const interval = intervalMap[new URL(url, "http://x").searchParams.get("interval") ?? "5m"] ?? 300;
  const rows = await sql<Record<string, unknown>[]>`
    SELECT bucket_start, open_usd_e18, high_usd_e18, low_usd_e18, close_usd_e18, volume_usd_e6, trade_count
    FROM candles
    WHERE token_address = ${Buffer.from(token.slice(2), "hex")} AND interval_seconds = ${interval}
    ORDER BY bucket_start ASC LIMIT 1000
  `;
  json(res, 200, {
    interval,
    candles: rows.map((r) => ({
      time: r["bucket_start"],
      open: r["open_usd_e18"],
      high: r["high_usd_e18"],
      low: r["low_usd_e18"],
      close: r["close_usd_e18"],
      volumeUsdE6: r["volume_usd_e6"],
      trades: r["trade_count"],
    })),
  });
}

async function handleTrades(res: ServerResponse, token: string): Promise<void> {
  const sql = requireDb(res);
  if (sql === null) return;
  const rows = await sql<Record<string, unknown>[]>`
    SELECT tx_hash, block_time, is_buy, amount_token, volume_usd_e6, recipient, price_usd_e18
    FROM swaps WHERE token_address = ${Buffer.from(token.slice(2), "hex")}
    ORDER BY block_time DESC LIMIT 100
  `;
  json(res, 200, {
    trades: rows.map((r) => ({
      txHash: `0x${(r["tx_hash"] as Buffer).toString("hex")}`,
      time: r["block_time"],
      side: (r["is_buy"] as boolean) ? "buy" : "sell",
      amountToken: r["amount_token"],
      valueUsdE6: r["volume_usd_e6"],
      wallet: `0x${(r["recipient"] as Buffer).toString("hex")}`,
      priceUsdE18: r["price_usd_e18"],
    })),
  });
}

async function handlePlatformStats(res: ServerResponse): Promise<void> {
  const sql = requireDb(res);
  if (sql === null) return;
  const [counts] = await sql<Record<string, unknown>[]>`
    SELECT
      (SELECT count(*) FROM tokens) AS token_count,
      (SELECT count(*) FROM tokens WHERE graduated) AS graduated_count,
      (SELECT count(*) FROM swaps) AS swap_count
  `;
  json(res, 200, {
    tokenCount: counts?.["token_count"] ?? 0,
    graduatedCount: counts?.["graduated_count"] ?? 0,
    swapCount: counts?.["swap_count"] ?? 0,
  });
}

// -------------------------------------------------------------------- server

const server = createServer((req, res) => {
  const url = req.url ?? "/";
  const run = async (): Promise<void> => {
    if (url === "/healthz") {
      json(res, 200, { status: "ok" });
      return;
    }
    if (url === "/v1/platform/config") {
      json(res, 200, {
        features: flags,
        fees: {
          bridgeDepositFeeBps: fees.bridgeDepositFeeBps,
          bridgeRedeemFeeBps: fees.bridgeRedeemFeeBps,
          pairFeeCreatorShareBps: fees.pairFeeCreatorShareBps,
          pairFeeProtocolShareBps: fees.pairFeeProtocolShareBps,
          gasStationMarginBps: fees.gasStationMarginBps,
          uniswapPoolFee: fees.uniswapPoolFee,
          launchFeeQuoteUnits: fees.launchFeeQuoteUnits,
        },
        contracts: { vaultBase: VAULT ?? null, bridgeArc: BRIDGE ?? null },
        note: "Deployed contracts are the live source of truth for fees.",
      });
      return;
    }
    if (url === "/v1/bridge/quote" && req.method === "POST") {
      await handleQuote(req, res);
      return;
    }
    const actionMatch = /^\/v1\/bridge\/actions\/(0x[0-9a-fA-F]+)$/.exec(url);
    if (actionMatch?.[1] !== undefined && req.method === "GET") {
      await handleAction(res, actionMatch[1]);
      return;
    }
    const addressMatch = /^\/v1\/bridge\/address\/(0x[0-9a-fA-F]+)$/.exec(url);
    if (addressMatch?.[1] !== undefined && req.method === "GET") {
      await handleAddress(res, addressMatch[1]);
      return;
    }
    if (url === "/v1/bridge/solvency" && req.method === "GET") {
      await handleSolvency(res);
      return;
    }
    const path = url.split("?")[0] ?? url;
    if (path === "/v1/tokens" && req.method === "GET") {
      await handleTokens(res, url);
      return;
    }
    const tokenDetail = /^\/v1\/tokens\/(0x[0-9a-fA-F]{40})$/.exec(path);
    if (tokenDetail?.[1] !== undefined && req.method === "GET") {
      await handleTokenDetail(res, tokenDetail[1]);
      return;
    }
    const candlesMatch = /^\/v1\/tokens\/(0x[0-9a-fA-F]{40})\/candles$/.exec(path);
    if (candlesMatch?.[1] !== undefined && req.method === "GET") {
      await handleCandles(res, candlesMatch[1], url);
      return;
    }
    const tradesMatch = /^\/v1\/tokens\/(0x[0-9a-fA-F]{40})\/trades$/.exec(path);
    if (tradesMatch?.[1] !== undefined && req.method === "GET") {
      await handleTrades(res, tradesMatch[1]);
      return;
    }
    if (path === "/v1/platform/stats" && req.method === "GET") {
      await handlePlatformStats(res);
      return;
    }
    json(res, 501, {
      error: "not_implemented",
      detail: `Route ${url} is not a known endpoint.`,
    });
  };
  run().catch((err: unknown) => {
    log.error({ err, url }, "request failed");
    json(res, 500, { error: "internal_error" });
  });
});

server.listen(env.API_PORT, () => {
  log.info({ port: env.API_PORT, vault: VAULT ?? "unset", bridge: BRIDGE ?? "unset" }, "arch-api listening");
});
