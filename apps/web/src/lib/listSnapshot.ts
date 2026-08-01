import { getDb } from "@/lib/db";
import type { LaunchpadToken } from "@/lib/launchpad";

/**
 * Durable snapshot of the launch list. Every successful chain read is written
 * here; when the chain is unreachable (Arc's private-mainnet RPC gate, a
 * provider outage) the site serves the last known list instead of an empty
 * page. Tokens never disappear from the launchpad just because we can't reach
 * a node — the data is still true, only staleness changes.
 */

interface Row {
  readonly payload: string;
  readonly saved_at: string;
}

/** bigint-safe serialisation (LaunchpadToken carries several). */
function serialize(tokens: readonly LaunchpadToken[]): string {
  return JSON.stringify(tokens, (_k, v) => (typeof v === "bigint" ? `${v.toString()}n` : v));
}
function deserialize(payload: string): LaunchpadToken[] {
  return JSON.parse(payload, (_k, v) =>
    typeof v === "string" && /^\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v,
  ) as LaunchpadToken[];
}

/** In-process copy so an outage costs at most one DB round trip. */
let memo: { tokens: LaunchpadToken[]; at: number } | null = null;

export async function saveSnapshot(tokens: readonly LaunchpadToken[]): Promise<void> {
  if (tokens.length === 0) return; // never overwrite a good list with nothing
  memo = { tokens: [...tokens], at: Date.now() };
  const sql = getDb();
  if (sql === null) return;
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS token_list_snapshot (
        id int PRIMARY KEY DEFAULT 1,
        payload text NOT NULL,
        saved_at timestamptz NOT NULL DEFAULT now()
      )
    `;
    await sql`
      INSERT INTO token_list_snapshot (id, payload, saved_at)
      VALUES (1, ${serialize(tokens)}, now())
      ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload, saved_at = now()
    `;
  } catch {
    // memo still serves this instance
  }
}

export async function loadSnapshot(): Promise<{ tokens: LaunchpadToken[]; savedAt: number } | null> {
  if (memo !== null) return { tokens: memo.tokens, savedAt: memo.at };
  const sql = getDb();
  if (sql === null) return null;
  try {
    const rows = await sql<Row[]>`SELECT payload, saved_at FROM token_list_snapshot WHERE id = 1 LIMIT 1`;
    const row = rows[0];
    if (row === undefined) return null;
    const tokens = deserialize(row.payload);
    memo = { tokens, at: new Date(row.saved_at).getTime() };
    return { tokens, savedAt: memo.at };
  } catch {
    return null;
  }
}
