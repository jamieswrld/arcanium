import "server-only";
import { getDb } from "@/lib/db";

/**
 * A tiny cross-instance cache.
 *
 * In-process Maps are the right tool on a long-lived server and the wrong one
 * on serverless: each request can land on a fresh instance, so a 60s memo never
 * gets a second hit and every visitor pays the full cold cost. Measured on
 * production, Explore stayed at 12-15s across repeated loads for exactly this
 * reason while the same code warmed to 0.02s locally.
 *
 * Next's unstable_cache would be the obvious answer, but it serialises through
 * JSON and our values are full of bigints — amounts, block numbers, prices —
 * which JSON.stringify throws on. So this stores through the bigint-safe codec
 * the launch snapshot already uses, in the Postgres we already have.
 *
 * Degrades to the in-process layer when there is no database: correctness never
 * depends on the cache, only speed.
 */

interface Row {
  readonly payload: string;
  readonly saved_at: string;
}

/** bigints round-trip as "123n" strings; nothing else is touched. */
function encode(value: unknown): string {
  return JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? `${v.toString()}n` : v));
}
function decode<T>(payload: string): T {
  return JSON.parse(payload, (_k, v) =>
    typeof v === "string" && /^-?\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v,
  ) as T;
}

/** Per-instance layer, so a warm instance skips the database round trip too. */
const memo = new Map<string, { at: number; value: unknown }>();
const inFlight = new Map<string, Promise<unknown>>();

let ready: Promise<void> | null = null;
async function ensureTable(sql: NonNullable<ReturnType<typeof getDb>>): Promise<void> {
  ready ??= (async () => {
    await sql`
      CREATE TABLE IF NOT EXISTS kv_cache (
        k text PRIMARY KEY,
        payload text NOT NULL,
        saved_at timestamptz NOT NULL DEFAULT now()
      )
    `;
  })();
  await ready;
}

/**
 * Return `key`'s cached value, or compute and store it.
 *
 * Concurrent callers on one instance share a single computation, so a burst of
 * requests to a cold instance triggers one chain read rather than N.
 */
export async function cached<T>(key: string, ttlMs: number, compute: () => Promise<T>): Promise<T> {
  const hit = memo.get(key);
  if (hit !== undefined && Date.now() - hit.at < ttlMs) return hit.value as T;

  const pending = inFlight.get(key);
  if (pending !== undefined) return pending as Promise<T>;

  const run = (async (): Promise<T> => {
    const sql = getDb();

    if (sql !== null) {
      try {
        await ensureTable(sql);
        const rows = await sql<Row[]>`SELECT payload, saved_at FROM kv_cache WHERE k = ${key} LIMIT 1`;
        const row = rows[0];
        if (row !== undefined) {
          const age = Date.now() - new Date(row.saved_at).getTime();
          if (age < ttlMs) {
            const value = decode<T>(row.payload);
            memo.set(key, { at: Date.now() - age, value });
            return value;
          }
        }
      } catch {
        // Unavailable or not yet created — fall through and compute.
      }
    }

    const value = await compute();
    memo.set(key, { at: Date.now(), value });

    if (sql !== null) {
      try {
        await sql`
          INSERT INTO kv_cache (k, payload, saved_at)
          VALUES (${key}, ${encode(value)}, now())
          ON CONFLICT (k) DO UPDATE SET payload = EXCLUDED.payload, saved_at = now()
        `;
      } catch {
        // Best effort: the in-process copy still serves this instance.
      }
    }
    return value;
  })();

  inFlight.set(key, run);
  try {
    return await run;
  } finally {
    inFlight.delete(key);
  }
}
