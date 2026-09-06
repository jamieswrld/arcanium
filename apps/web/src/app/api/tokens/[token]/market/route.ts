import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getChain } from "@/lib/chains";

/**
 * Persistent market data for a token: full candle history (per interval) and
 * recent trades, from the indexer's Postgres. Falls back to 503 if the DB is
 * unset (the client then reads a bounded window from chain).
 */
const INTERVALS: Record<string, number> = { "1m": 60, "5m": 300, "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400 };

export async function GET(
  request: Request,
  context: { params: Promise<{ token: string }> },
): Promise<NextResponse> {
  const { token } = await context.params;
  if (!/^0x[0-9a-fA-F]{40}$/.test(token)) {
    return NextResponse.json({ error: "invalid token" }, { status: 400 });
  }
  const sql = getDb();
  if (sql === null) {
    return NextResponse.json({ error: "database not configured" }, { status: 503 });
  }
  const params = new URL(request.url).searchParams;
  const interval = INTERVALS[params.get("interval") ?? "5m"] ?? 300;
  // The chart seeds its whole history from this, so it needs more than a
  // preview. Bounded so a crafted query cannot ask for the entire table.
  const requested = Number.parseInt(params.get("trades") ?? "100", 10);
  const tradeLimit = Number.isFinite(requested) ? Math.min(Math.max(requested, 1), 2000) : 100;
  const tokenBuf = Buffer.from(token.slice(2), "hex");
  // This database still holds rows from an old Arc *testnet* run. Without the
  // chain filter a testnet token's trades would render on the mainnet site.
  const chainId = getChain("arc").id;
  try {
    const [candles, trades] = await Promise.all([
      sql<Record<string, string>[]>`
        SELECT bucket_start, open_usd_e18, high_usd_e18, low_usd_e18, close_usd_e18, volume_usd_e6, trade_count
        FROM candles c
        WHERE c.token_address = ${tokenBuf} AND c.interval_seconds = ${interval}
          AND EXISTS (SELECT 1 FROM tokens t WHERE t.token_address = c.token_address AND t.chain_id = ${chainId})
        ORDER BY bucket_start ASC LIMIT 1000
      `,
      sql<Record<string, unknown>[]>`
        SELECT tx_hash, block_number, block_time, is_buy, amount_token, volume_usd_e6,
               price_usd_e18, recipient
        FROM swaps WHERE token_address = ${tokenBuf} AND chain_id = ${chainId}
        ORDER BY block_time DESC LIMIT ${tradeLimit}
      `,
    ]);
    return NextResponse.json({
      interval,
      candles: candles.map((c) => ({
        time: c["bucket_start"],
        open: c["open_usd_e18"],
        high: c["high_usd_e18"],
        low: c["low_usd_e18"],
        close: c["close_usd_e18"],
        volumeUsdE6: c["volume_usd_e6"],
      })),
      trades: trades.map((t) => ({
        txHash: `0x${(t["tx_hash"] as Buffer).toString("hex")}`,
        blockNumber: String(t["block_number"]),
        time: t["block_time"],
        side: (t["is_buy"] as boolean) ? "buy" : "sell",
        amountToken: String(t["amount_token"]),
        valueUsdE6: String(t["volume_usd_e6"]),
        // The chart buckets its own candles from these, so it needs the price
        // each trade left behind — otherwise it has to re-read the logs itself.
        priceUsdE18: String(t["price_usd_e18"]),
        wallet: `0x${(t["recipient"] as Buffer).toString("hex")}`,
      })),
      source: "indexer",
    });
  } catch (err) {
    const message = err instanceof Error ? (err.message.split("\n")[0] ?? "failed") : "failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
