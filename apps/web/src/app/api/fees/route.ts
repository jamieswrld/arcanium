import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getChain } from "@/lib/chains";
import { indexerHealth } from "@/lib/indexed";

/**
 * Fees already paid out, per token.
 *
 * The portfolio used to sum FeesDistributed itself in the browser, walking back
 * in 45,000-block chunks. Arc refuses any getLogs range much over 10,000, so the
 * first request threw and the loop broke — "Already claimed" has read zero for
 * every creator since the page was written, which is a payout figure shown wrong
 * on the page people open to see what they have earned.
 *
 * 503 when the indexer is behind, so the caller falls back rather than showing a
 * total that is missing recent claims.
 */

export const dynamic = "force-dynamic";

interface Row {
  readonly token_address: Buffer;
  readonly creator: string;
  readonly gross: string;
}

export async function GET(request: Request): Promise<NextResponse> {
  const raw = new URL(request.url).searchParams.get("tokens") ?? "";
  const tokens = raw
    .split(",")
    .map((t) => t.trim())
    .filter((t) => /^0x[0-9a-fA-F]{40}$/.test(t));
  if (tokens.length === 0) return NextResponse.json({ fees: {} });
  if (tokens.length > 200) {
    return NextResponse.json({ error: "too many tokens" }, { status: 400 });
  }

  const health = await indexerHealth().catch(() => null);
  if (health === null || !health.caughtUp) {
    return NextResponse.json({ error: "indexer not caught up" }, { status: 503 });
  }

  const sql = getDb();
  if (sql === null) return NextResponse.json({ error: "database not configured" }, { status: 503 });

  try {
    const keys = tokens.map((t) => Buffer.from(t.slice(2), "hex"));
    const rows = await sql<Row[]>`
      SELECT
        f.token_address,
        SUM(f.creator_reward)::text                        AS creator,
        SUM(f.creator_reward + f.protocol_reward)::text     AS gross
      FROM fee_distributions f
      JOIN tokens t ON t.token_address = f.token_address AND t.chain_id = ${getChain("arc").id}
      -- IN over a value list, not = ANY(array): postgres.js sends a bytea[] that
      -- Postgres rejects with "op ANY/ALL (array) requires array on right side".
      WHERE f.token_address IN ${sql(keys)}
      GROUP BY f.token_address
    `;
    const fees: Record<string, { creator: string; gross: string }> = {};
    for (const r of rows) {
      fees[`0x${r.token_address.toString("hex")}`] = { creator: r.creator, gross: r.gross };
    }
    return NextResponse.json({ fees, source: "indexer" });
  } catch (err) {
    // Logged, not swallowed: this route failing looks identical to a creator
    // having earned nothing, which is the exact confusion it exists to end.
    console.error("[api/fees] query failed", err);
    return NextResponse.json({ error: "query failed" }, { status: 502 });
  }
}
