import { getDb } from "@/lib/db";
import type { LaunchpadToken } from "@/lib/launchpad";
import type { ChainKey } from "@/lib/chains";

/**
 * Durable snapshot of the launch list, per chain. Every successful chain read is
 * written here; when a chain is unreachable (Arc's private-mainnet RPC gate, a
 * provider outage) the site serves that chain's last known list instead of an
 * empty page. Tokens never disappear from the launchpad just because we can't
 * reach a node — the data is still true, only staleness changes.
 *
 * Arc keeps row id 1 so existing snapshots survive; other chains get their own
 * rows keyed by chain.
 */

interface Row {
  readonly payload: string;
  readonly saved_at: string;
}

/** Stable row id per chain. Arc is 1 for backwards compatibility. */
const ROW_ID: Record<ChainKey, number> = { arc: 1 };

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
const memo = new Map<ChainKey, { tokens: LaunchpadToken[]; at: number }>();

async function ensureTable(sql: NonNullable<ReturnType<typeof getDb>>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS token_list_snapshot (
      id int PRIMARY KEY DEFAULT 1,
      payload text NOT NULL,
      saved_at timestamptz NOT NULL DEFAULT now()
    )
  `;
}

export async function saveSnapshot(
  tokens: readonly LaunchpadToken[],
  chain: ChainKey = "arc",
): Promise<void> {
  if (tokens.length === 0) return; // never overwrite a good list with nothing
  memo.set(chain, { tokens: [...tokens], at: Date.now() });
  const sql = getDb();
  if (sql === null) return;
  try {
    await ensureTable(sql);
    await sql`
      INSERT INTO token_list_snapshot (id, payload, saved_at)
      VALUES (${ROW_ID[chain]}, ${serialize(tokens)}, now())
      ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload, saved_at = now()
    `;
  } catch {
    // memo still serves this instance
  }
}

export async function loadSnapshot(
  chain: ChainKey = "arc",
): Promise<{ tokens: LaunchpadToken[]; savedAt: number } | null> {
  const hit = memo.get(chain);
  if (hit !== undefined) return { tokens: hit.tokens, savedAt: hit.at };
  const sql = getDb();
  if (sql === null) return null;
  try {
    const rows = await sql<Row[]>`
      SELECT payload, saved_at FROM token_list_snapshot WHERE id = ${ROW_ID[chain]} LIMIT 1
    `;
    const row = rows[0];
    if (row === undefined) return null;
    const tokens = deserialize(row.payload);
    const at = new Date(row.saved_at).getTime();
    memo.set(chain, { tokens, at });
    return { tokens, savedAt: at };
  } catch {
    return null;
  }
}

/**
 * Persisted per-chain reachability.
 *
 * The in-process circuit breaker only helps a warm instance. On serverless every
 * cold start would otherwise re-probe a chain we already know is gated and pay
 * the full read budget before serving the snapshot it was always going to serve.
 * Recording the outcome centrally lets a cold instance skip straight to the
 * snapshot, and lets any instance notice recovery.
 */
interface StatusRow {
  readonly down_at: string | null;
}

export async function markChainStatus(chain: ChainKey, down: boolean): Promise<void> {
  const sql = getDb();
  if (sql === null) return;
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS chain_status (
        chain text PRIMARY KEY,
        down_at timestamptz
      )
    `;
    await sql`
      INSERT INTO chain_status (chain, down_at)
      VALUES (${chain}, ${down ? new Date().toISOString() : null})
      ON CONFLICT (chain) DO UPDATE SET down_at = EXCLUDED.down_at
    `;
  } catch {
    // best effort — the in-process memo still protects this instance
  }
}

/** Milliseconds since this chain was last recorded down, or null if it is not. */
export async function chainDownFor(chain: ChainKey): Promise<number | null> {
  const sql = getDb();
  if (sql === null) return null;
  try {
    const rows = await sql<StatusRow[]>`SELECT down_at FROM chain_status WHERE chain = ${chain} LIMIT 1`;
    const at = rows[0]?.down_at;
    if (at === undefined || at === null) return null;
    return Date.now() - new Date(at).getTime();
  } catch {
    return null;
  }
}
