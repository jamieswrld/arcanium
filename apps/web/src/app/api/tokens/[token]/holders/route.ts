import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { indexerHealth } from "@/lib/indexed";
import { getChain } from "@/lib/chains";

/**
 * Top holders of a token, from the indexer.
 *
 * The browser used to derive this itself by walking Transfer logs backwards in
 * 45,000-block chunks. Arc rejects any getLogs range much above 10,000, so the
 * first request threw and the loop stopped — the tab has always shown just the
 * pool and the creator. Doing it here means real balances over the token's whole
 * history, in one indexed query.
 *
 * 503 when the indexer is not caught up, so the client can fall back rather than
 * render a confidently wrong list.
 */

export const dynamic = "force-dynamic";

interface Row {
  readonly holder: Buffer;
  readonly balance: string;
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ token: string }> },
): Promise<NextResponse> {
  const { token } = await context.params;
  if (!/^0x[0-9a-fA-F]{40}$/.test(token)) {
    return NextResponse.json({ error: "invalid token" }, { status: 400 });
  }

  const health = await indexerHealth().catch(() => null);
  if (health === null || !health.caughtUp) {
    return NextResponse.json({ error: "indexer not caught up" }, { status: 503 });
  }

  const sql = getDb();
  if (sql === null) return NextResponse.json({ error: "database not configured" }, { status: 503 });

  try {
    const rows = await sql<Row[]>`
      SELECT h.holder, h.balance::text AS balance
      FROM holders h
      JOIN tokens t ON t.token_address = h.token_address AND t.chain_id = ${getChain("arc").id}
      WHERE h.token_address = ${Buffer.from(token.slice(2), "hex")} AND h.balance > 0
      ORDER BY balance DESC
      LIMIT 50
    `;
    return NextResponse.json({
      holders: rows.map((r) => ({
        wallet: `0x${r.holder.toString("hex")}`,
        balance: r.balance,
      })),
      source: "indexer",
    });
  } catch {
    return NextResponse.json({ error: "query failed" }, { status: 502 });
  }
}
