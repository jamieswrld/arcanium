import { getDb } from "@/lib/db";
import { getChain } from "@/lib/chains";

/**
 * Token locks, read from the indexer.
 *
 * Status is computed here rather than stored, because LOCKED / CLAIMABLE /
 * CLAIMED is a function of the clock: a stored column would be wrong for
 * however long it took a job to notice a lock had matured. The contract is the
 * authority on whether a claim will succeed; this is a view of it.
 *
 * Note the deliberate absence of a TVL figure. Valuing a lock needs a price for
 * an arbitrary ERC-20, and for most tokens on Arc we do not have one worth
 * quoting. Counting locks and tokens is honest; inventing dollars is not.
 */

export type LockStatus = "locked" | "claimable" | "claimed";

export interface LockRow {
  readonly lockId: string;
  readonly token: string;
  readonly depositor: string;
  readonly beneficiary: string;
  /** Raw token units, as a decimal string. Decimals come from the token. */
  readonly amount: string;
  readonly createdAt: string;
  readonly unlockTime: string;
  readonly createdTx: string;
  readonly createdBlock: string;
  readonly claimedAt: string | null;
  readonly claimedTx: string | null;
  readonly status: LockStatus;
  /** Seconds until unlock; 0 once matured. */
  readonly secondsRemaining: number;
}

interface Raw {
  readonly lock_id: string;
  readonly token_address: Buffer;
  readonly depositor: Buffer;
  readonly beneficiary: Buffer;
  readonly amount: string;
  readonly created_at: Date;
  readonly unlock_time: Date;
  readonly created_block: string;
  readonly created_tx: Buffer;
  readonly claimed_at: Date | null;
  readonly claimed_tx: Buffer | null;
}

const hex = (b: Buffer): string => `0x${b.toString("hex")}`;

function toRow(r: Raw, now: number): LockRow {
  const unlockMs = r.unlock_time.getTime();
  const status: LockStatus =
    r.claimed_at !== null ? "claimed" : now >= unlockMs ? "claimable" : "locked";
  return {
    lockId: r.lock_id,
    token: hex(r.token_address),
    depositor: hex(r.depositor),
    beneficiary: hex(r.beneficiary),
    amount: r.amount,
    createdAt: r.created_at.toISOString(),
    unlockTime: r.unlock_time.toISOString(),
    createdBlock: r.created_block,
    createdTx: hex(r.created_tx),
    claimedAt: r.claimed_at?.toISOString() ?? null,
    claimedTx: r.claimed_tx === null ? null : hex(r.claimed_tx),
    status,
    secondsRemaining: status === "locked" ? Math.ceil((unlockMs - now) / 1000) : 0,
  };
}

const COLUMNS =
  "lock_id, token_address, depositor, beneficiary, amount, created_at, unlock_time, created_block, created_tx, claimed_at, claimed_tx";

export interface LockQuery {
  readonly token?: string | undefined;
  readonly wallet?: string | undefined;
  /** Which side of a lock `wallet` should match. Both, by default. */
  readonly role?: "depositor" | "beneficiary" | "any" | undefined;
  readonly status?: LockStatus | "all" | undefined;
  readonly limit?: number | undefined;
  readonly offset?: number | undefined;
}

/**
 * Locks matching a query, newest first.
 *
 * Returns null when the database is unavailable, so callers can answer 503
 * rather than an empty list — "no locks" and "cannot tell" are different
 * answers and a locker that reports the first when it means the second is
 * actively misleading.
 */
export async function lockList(q: LockQuery): Promise<{ locks: LockRow[]; total: number } | null> {
  const sql = getDb();
  if (sql === null) return null;
  const chainId = getChain("arc").id;
  const limit = Math.min(Math.max(q.limit ?? 50, 1), 200);
  const offset = Math.max(q.offset ?? 0, 0);
  const now = Date.now();

  const token = q.token === undefined ? null : Buffer.from(q.token.slice(2), "hex");
  const wallet = q.wallet === undefined ? null : Buffer.from(q.wallet.slice(2), "hex");
  const role = q.role ?? "any";
  const status = q.status ?? "all";

  try {
    const rows = await sql<Raw[]>`
      SELECT ${sql.unsafe(COLUMNS)} FROM token_locks
      WHERE chain_id = ${chainId}
        ${token === null ? sql`` : sql`AND token_address = ${token}`}
        ${
          wallet === null
            ? sql``
            : role === "depositor"
              ? sql`AND depositor = ${wallet}`
              : role === "beneficiary"
                ? sql`AND beneficiary = ${wallet}`
                : sql`AND (depositor = ${wallet} OR beneficiary = ${wallet})`
        }
        ${
          status === "all"
            ? sql``
            : status === "claimed"
              ? sql`AND claimed_at IS NOT NULL`
              : status === "claimable"
                ? sql`AND claimed_at IS NULL AND unlock_time <= now()`
                : sql`AND claimed_at IS NULL AND unlock_time > now()`
        }
      ORDER BY created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `;
    const counted = await sql<{ n: string }[]>`
      SELECT COUNT(*)::text AS n FROM token_locks
      WHERE chain_id = ${chainId}
        ${token === null ? sql`` : sql`AND token_address = ${token}`}
        ${
          wallet === null
            ? sql``
            : role === "depositor"
              ? sql`AND depositor = ${wallet}`
              : role === "beneficiary"
                ? sql`AND beneficiary = ${wallet}`
                : sql`AND (depositor = ${wallet} OR beneficiary = ${wallet})`
        }
        ${
          status === "all"
            ? sql``
            : status === "claimed"
              ? sql`AND claimed_at IS NOT NULL`
              : status === "claimable"
                ? sql`AND claimed_at IS NULL AND unlock_time <= now()`
                : sql`AND claimed_at IS NULL AND unlock_time > now()`
        }
    `;
    return {
      locks: rows.map((r) => toRow(r, now)),
      total: Number(counted[0]?.n ?? "0"),
    };
  } catch {
    return null;
  }
}

export async function lockById(lockId: string): Promise<LockRow | null> {
  const sql = getDb();
  if (sql === null) return null;
  try {
    const rows = await sql<Raw[]>`
      SELECT ${sql.unsafe(COLUMNS)} FROM token_locks
      WHERE chain_id = ${getChain("arc").id} AND lock_id = ${lockId}
    `;
    const r = rows[0];
    return r === undefined ? null : toRow(r, Date.now());
  } catch {
    return null;
  }
}

export interface LockStats {
  readonly activeLocks: number;
  readonly distinctTokens: number;
  /** Matured but unclaimed — money sitting there waiting to be collected. */
  readonly claimable: number;
  /** Locks maturing in the next seven days. */
  readonly unlockingSoon: number;
}

/** Headline counts. Deliberately no TVL — see the note at the top. */
export async function lockStats(): Promise<LockStats | null> {
  const sql = getDb();
  if (sql === null) return null;
  try {
    const rows = await sql<
      { active: string; tokens: string; claimable: string; soon: string }[]
    >`
      SELECT
        COUNT(*) FILTER (WHERE claimed_at IS NULL)::text AS active,
        COUNT(DISTINCT token_address)::text AS tokens,
        COUNT(*) FILTER (WHERE claimed_at IS NULL AND unlock_time <= now())::text AS claimable,
        COUNT(*) FILTER (
          WHERE claimed_at IS NULL AND unlock_time > now()
            AND unlock_time <= now() + interval '7 days'
        )::text AS soon
      FROM token_locks WHERE chain_id = ${getChain("arc").id}
    `;
    const r = rows[0];
    if (r === undefined) return null;
    return {
      activeLocks: Number(r.active),
      distinctTokens: Number(r.tokens),
      claimable: Number(r.claimable),
      unlockingSoon: Number(r.soon),
    };
  } catch {
    return null;
  }
}

/** Total still locked for one token, and how many locks hold it. */
export async function lockedForToken(
  token: string,
): Promise<{ amount: bigint; locks: number } | null> {
  const sql = getDb();
  if (sql === null) return null;
  try {
    const rows = await sql<{ amount: string | null; n: string }[]>`
      SELECT COALESCE(SUM(amount), 0)::text AS amount, COUNT(*)::text AS n
      FROM token_locks
      WHERE chain_id = ${getChain("arc").id}
        AND token_address = ${Buffer.from(token.slice(2), "hex")}
        AND claimed_at IS NULL
    `;
    const r = rows[0];
    if (r === undefined) return null;
    return { amount: BigInt(r.amount ?? "0"), locks: Number(r.n) };
  } catch {
    return null;
  }
}
