import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getChain } from "@/lib/chains";

/**
 * One wallet's trading history in one token.
 *
 * Returns what the wallet bought and sold and at what average price, so the
 * token page can show a position rather than making someone reconstruct it from
 * the trade feed. Balance is deliberately *not* returned: the chain is the only
 * honest source for that, and the client already holds a wallet connection.
 *
 * Cost basis is the average price actually paid across buys — not FIFO, and not
 * netted against sells. Anything cleverer would be guessing at an accounting
 * method the user never chose.
 */
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ token: string }> },
): Promise<NextResponse> {
  const { token } = await context.params;
  const wallet = new URL(request.url).searchParams.get("wallet") ?? "";
  if (!/^0x[0-9a-fA-F]{40}$/.test(token)) {
    return NextResponse.json({ error: "invalid token" }, { status: 400 });
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(wallet)) {
    return NextResponse.json({ error: "invalid wallet" }, { status: 400 });
  }

  const sql = getDb();
  if (sql === null) return NextResponse.json({ error: "database not configured" }, { status: 503 });

  const tokenBuf = Buffer.from(token.slice(2), "hex");
  const walletBuf = Buffer.from(wallet.slice(2), "hex");
  // The same testnet rows that haunt every other query here.
  const chainId = getChain("arc").id;

  try {
    const rows = await sql<
      { is_buy: boolean; tokens: string | null; usd: string | null; n: string; first: Date | null; last: Date | null }[]
    >`
      SELECT is_buy,
             COALESCE(SUM(amount_token), 0)::text AS tokens,
             COALESCE(SUM(volume_usd_e6), 0)::text AS usd,
             COUNT(*)::text AS n,
             MIN(block_time) AS first,
             MAX(block_time) AS last
      FROM swaps
      WHERE token_address = ${tokenBuf} AND chain_id = ${chainId} AND recipient = ${walletBuf}
      GROUP BY is_buy
    `;

    const side = (buy: boolean) => rows.find((r) => r.is_buy === buy);
    const b = side(true);
    const s = side(false);
    const times = rows
      .flatMap((r) => [r.first, r.last])
      .filter((d): d is Date => d !== null)
      .map((d) => d.getTime());

    return NextResponse.json({
      wallet,
      bought: {
        tokens: b?.tokens ?? "0",
        usdUnits: b?.usd ?? "0",
        trades: Number(b?.n ?? "0"),
      },
      sold: {
        tokens: s?.tokens ?? "0",
        usdUnits: s?.usd ?? "0",
        trades: Number(s?.n ?? "0"),
      },
      firstTradeAt: times.length > 0 ? new Date(Math.min(...times)).toISOString() : null,
      lastTradeAt: times.length > 0 ? new Date(Math.max(...times)).toISOString() : null,
      source: "indexer",
    });
  } catch (err) {
    const message = err instanceof Error ? (err.message.split("\n")[0] ?? "failed") : "failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
