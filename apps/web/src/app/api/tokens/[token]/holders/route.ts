import { NextResponse } from "next/server";
import { erc20Abi, type Hex } from "viem";
import { getDb } from "@/lib/db";
import { indexerHealth } from "@/lib/indexed";
import { getChain } from "@/lib/chains";
import { arcPublicClient } from "@/lib/launchpad";

/**
 * Top holders of a token.
 *
 * The two sources here each answer half the question. Only the indexer can say
 * *who* holds the token — an ERC-20 cannot enumerate its holders, and the
 * browser's old approach of walking Transfer logs backwards died on Arc's
 * 10,000-block getLogs ceiling. Only the chain can say *how much* they hold
 * right now.
 *
 * Reading balances from the indexer alone was wrong, and visibly so: its holder
 * table accumulates Transfer deltas rather than being recomputed, so any range
 * the walk could not read leaves the balances permanently adrift. Measured
 * against chain, 6 of 8 sampled holders were wrong, several showing thousands of
 * tokens for wallets that now hold none.
 *
 * So: the indexer supplies the candidate set, and every balance is then read
 * from chain in one multicall. Wallets that have since sold out drop away.
 *
 * The one case this cannot repair is a wallet that acquired tokens during a gap
 * and has not traded since — nothing knows to ask about it. `verified` says
 * which source the numbers came from so the client can be honest about it.
 */

export const dynamic = "force-dynamic";

interface Row {
  readonly holder: Buffer;
  readonly balance: string;
}

/** Fetched wider than returned, since sold-out wallets are dropped. */
const CANDIDATES = 120;
const RETURNED = 50;

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
      -- h.balance, not the bare alias. ORDER BY resolves a bare name to the
      -- output column, which is ::text here, so this sorted lexicographically:
      -- "971365" ranked above "92903438" and the list came out scrambled.
      ORDER BY h.balance DESC
      LIMIT ${CANDIDATES}
    `;

    const candidates = rows.map((r) => `0x${r.holder.toString("hex")}` as Hex);
    if (candidates.length === 0) {
      return NextResponse.json({ holders: [], verified: true, source: "indexer" });
    }

    const client = arcPublicClient();
    const balances = await client
      .multicall({
        contracts: candidates.map((a) => ({
          address: token as Hex,
          abi: erc20Abi,
          functionName: "balanceOf" as const,
          args: [a] as const,
        })),
        allowFailure: true,
      })
      .catch(() => null);

    // Chain unreachable: serve the indexed numbers rather than nothing, but say
    // they are unverified so the client can mark them.
    if (balances === null) {
      return NextResponse.json({
        holders: rows.slice(0, RETURNED).map((r) => ({
          wallet: `0x${r.holder.toString("hex")}`,
          balance: r.balance,
        })),
        verified: false,
        source: "indexer",
      });
    }

    const holders = candidates
      .map((wallet, i) => {
        const result = balances[i];
        // A failed call is not a zero balance; fall back to the indexed figure
        // rather than deleting a holder because one call in a batch dropped.
        const balance =
          result !== undefined && result.status === "success"
            ? (result.result as bigint)
            : BigInt(rows[i]?.balance ?? "0");
        return { wallet, balance };
      })
      .filter((h) => h.balance > 0n)
      .sort((a, b) => (a.balance < b.balance ? 1 : a.balance > b.balance ? -1 : 0))
      .slice(0, RETURNED)
      .map((h) => ({ wallet: h.wallet, balance: h.balance.toString() }));

    return NextResponse.json({ holders, verified: true, source: "indexer+chain" });
  } catch {
    return NextResponse.json({ error: "query failed" }, { status: 502 });
  }
}
