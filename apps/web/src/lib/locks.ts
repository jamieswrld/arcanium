import { erc20Abi } from "viem";
import { getDb } from "@/lib/db";
import { getChain } from "@/lib/chains";
import { arcPublicClient } from "@/lib/launchpad";
import { ARC_TOKEN_LOCKER } from "@arch/chain-config";

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
  /**
   * Token metadata when Arcanium launched it. Null for any other ERC-20 — the
   * locker works for arbitrary tokens, and the indexer only knows the ones it
   * launched. The UI falls back to the contract address, which is the honest
   * thing to show for an unknown token anyway: a symbol is trivially spoofable
   * and an address is not.
   */
  readonly symbol: string | null;
  readonly name: string | null;
  readonly decimals: number | null;
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
  readonly symbol: string | null;
  readonly name: string | null;
  readonly decimals: number | null;
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
    symbol: r.symbol,
    name: r.name,
    decimals: r.decimals,
  };
}

// Left join, not inner: a lock on a token Arcanium did not launch is perfectly
// valid and must still be listed.
const COLUMNS = `l.lock_id, l.token_address, l.depositor, l.beneficiary, l.amount,
  l.created_at, l.unlock_time, l.created_block, l.created_tx, l.claimed_at, l.claimed_tx,
  t.symbol, t.name, t.decimals`;

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
      SELECT ${sql.unsafe(COLUMNS)} FROM token_locks l
      LEFT JOIN tokens t ON t.token_address = l.token_address AND t.chain_id = l.chain_id
      WHERE l.chain_id = ${chainId}
        ${token === null ? sql`` : sql`AND l.token_address = ${token}`}
        ${
          wallet === null
            ? sql``
            : role === "depositor"
              ? sql`AND l.depositor = ${wallet}`
              : role === "beneficiary"
                ? sql`AND l.beneficiary = ${wallet}`
                : sql`AND (l.depositor = ${wallet} OR l.beneficiary = ${wallet})`
        }
        ${
          status === "all"
            ? sql``
            : status === "claimed"
              ? sql`AND l.claimed_at IS NOT NULL`
              : status === "claimable"
                ? sql`AND l.claimed_at IS NULL AND l.unlock_time <= now()`
                : sql`AND l.claimed_at IS NULL AND l.unlock_time > now()`
        }
      ORDER BY l.created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `;
    const counted = await sql<{ n: string }[]>`
      SELECT COUNT(*)::text AS n FROM token_locks l
      WHERE l.chain_id = ${chainId}
        ${token === null ? sql`` : sql`AND l.token_address = ${token}`}
        ${
          wallet === null
            ? sql``
            : role === "depositor"
              ? sql`AND l.depositor = ${wallet}`
              : role === "beneficiary"
                ? sql`AND l.beneficiary = ${wallet}`
                : sql`AND (l.depositor = ${wallet} OR l.beneficiary = ${wallet})`
        }
        ${
          status === "all"
            ? sql``
            : status === "claimed"
              ? sql`AND l.claimed_at IS NOT NULL`
              : status === "claimable"
                ? sql`AND l.claimed_at IS NULL AND l.unlock_time <= now()`
                : sql`AND l.claimed_at IS NULL AND l.unlock_time > now()`
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
      SELECT ${sql.unsafe(COLUMNS)} FROM token_locks l
      LEFT JOIN tokens t ON t.token_address = l.token_address AND t.chain_id = l.chain_id
      WHERE l.chain_id = ${getChain("arc").id} AND l.lock_id = ${lockId}
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

/* ------------------------------------------------------------ chain fallback */

const lockerAbi = [
  {
    type: "function",
    name: "lockCount",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "getLock",
    stateMutability: "view",
    inputs: [{ type: "uint256" }],
    outputs: [
      {
        components: [
          { name: "token", type: "address" },
          { name: "depositor", type: "address" },
          { name: "beneficiary", type: "address" },
          { name: "amount", type: "uint256" },
          { name: "createdAt", type: "uint64" },
          { name: "unlockTime", type: "uint64" },
          { name: "claimed", type: "bool" },
        ],
        type: "tuple",
      },
    ],
  },
] as const;

/**
 * One lock, read straight from the contract.
 *
 * The indexer is a few seconds behind at best, and somebody who has just paid
 * for a lock should not be told it does not exist. The chain is the authority
 * here anyway — this is not a cache miss, it is asking the source.
 *
 * What the chain cannot supply is the transaction that created or claimed it,
 * since that is only recoverable from logs; those come back null and the page
 * omits them until the indexer catches up.
 */
export async function lockFromChain(lockId: string): Promise<LockRow | null> {
  let id: bigint;
  try {
    id = BigInt(lockId);
  } catch {
    return null;
  }
  const client = arcPublicClient();
  const lock = await client
    .readContract({ address: ARC_TOKEN_LOCKER, abi: lockerAbi, functionName: "getLock", args: [id] })
    .catch(() => null);
  if (lock === null) return null;

  const [symbol, name, decimals] = await Promise.all([
    client.readContract({ address: lock.token, abi: erc20Abi, functionName: "symbol" }).catch(() => null),
    client.readContract({ address: lock.token, abi: erc20Abi, functionName: "name" }).catch(() => null),
    client.readContract({ address: lock.token, abi: erc20Abi, functionName: "decimals" }).catch(() => null),
  ]);

  const now = Date.now();
  const unlockMs = Number(lock.unlockTime) * 1000;
  const status: LockStatus = lock.claimed ? "claimed" : now >= unlockMs ? "claimable" : "locked";

  return {
    lockId,
    token: lock.token,
    depositor: lock.depositor,
    beneficiary: lock.beneficiary,
    amount: lock.amount.toString(),
    createdAt: new Date(Number(lock.createdAt) * 1000).toISOString(),
    unlockTime: new Date(unlockMs).toISOString(),
    createdBlock: "",
    createdTx: "",
    claimedAt: null,
    claimedTx: null,
    status,
    secondsRemaining: status === "locked" ? Math.ceil((unlockMs - now) / 1000) : 0,
    symbol: symbol === null ? null : String(symbol),
    name: name === null ? null : String(name),
    decimals: decimals === null ? null : Number(decimals),
  };
}

/** The indexer if it has the lock, otherwise the chain. */
export async function lockByIdOrChain(lockId: string): Promise<LockRow | null> {
  const indexed = await lockById(lockId);
  if (indexed !== null) return indexed;
  return lockFromChain(lockId);
}

/**
 * Recent locks, read straight from the contract.
 *
 * The locker keeps a count and hands out locks by id, so the chain can answer
 * "what locks exist" without help. That makes the indexer an optimisation here
 * rather than a dependency — which matters, because an indexer that is behind
 * would otherwise make a lock somebody just paid for appear not to exist.
 *
 * Bounded to the most recent `limit`, newest first. This is not a substitute
 * for indexing at scale — it is one call per lock — but it keeps the page
 * truthful when the indexer is unavailable, and at a few dozen locks it is
 * indistinguishable.
 */
export async function locksFromChain(limit = 60): Promise<LockRow[] | null> {
  const client = arcPublicClient();
  const count = await client
    .readContract({ address: ARC_TOKEN_LOCKER, abi: lockerAbi, functionName: "lockCount" })
    .catch(() => null);
  if (count === null) return null;

  const total = Number(count);
  if (total === 0) return [];
  const ids: bigint[] = [];
  for (let i = total; i > 0 && ids.length < limit; i--) ids.push(BigInt(i));

  const rows = await Promise.all(ids.map((id) => lockFromChain(id.toString())));
  return rows.filter((r): r is LockRow => r !== null);
}

/**
 * Locks for a query, from the indexer when it can answer and the chain when it
 * cannot.
 *
 * Filtering on the chain path happens in memory over the recent window, which
 * is the honest trade: a correct answer over the last N locks beats a complete
 * answer that is missing whatever the indexer has not read yet.
 */
export async function lockListResilient(
  q: LockQuery,
): Promise<{ locks: LockRow[]; total: number; source: "indexer" | "chain" } | null> {
  const indexed = await lockList(q);
  if (indexed !== null) {
    // The indexer answered — but if it has not seen a lock the chain already
    // has, it is behind and the chain is the better answer.
    const onChainCount = await arcPublicClient()
      .readContract({ address: ARC_TOKEN_LOCKER, abi: lockerAbi, functionName: "lockCount" })
      .catch(() => null);
    const behind =
      onChainCount !== null && q.token === undefined && q.wallet === undefined && q.status === undefined
        ? Number(onChainCount) > indexed.total
        : false;
    if (!behind) return { ...indexed, source: "indexer" };
  }

  const all = await locksFromChain();
  if (all === null) return indexed === null ? null : { ...indexed, source: "indexer" };

  const wallet = q.wallet?.toLowerCase();
  const role = q.role ?? "any";
  const filtered = all.filter((l) => {
    if (q.token !== undefined && l.token.toLowerCase() !== q.token.toLowerCase()) return false;
    if (wallet !== undefined) {
      const isDep = l.depositor.toLowerCase() === wallet;
      const isBen = l.beneficiary.toLowerCase() === wallet;
      if (role === "depositor" && !isDep) return false;
      if (role === "beneficiary" && !isBen) return false;
      if (role === "any" && !isDep && !isBen) return false;
    }
    if (q.status !== undefined && q.status !== "all" && l.status !== q.status) return false;
    return true;
  });
  return { locks: filtered, total: filtered.length, source: "chain" };
}

/** Headline counts, computed from chain when the indexer cannot answer. */
export async function lockStatsResilient(): Promise<LockStats | null> {
  const indexed = await lockStats();
  const onChainCount = await arcPublicClient()
    .readContract({ address: ARC_TOKEN_LOCKER, abi: lockerAbi, functionName: "lockCount" })
    .catch(() => null);

  const total = onChainCount === null ? null : Number(onChainCount);
  if (indexed !== null && (total === null || indexed.activeLocks + indexed.claimable === 0 || total <= indexed.activeLocks)) {
    return indexed;
  }
  const all = await locksFromChain();
  if (all === null) return indexed;

  const week = Date.now() + 7 * 86_400_000;
  return {
    activeLocks: all.filter((l) => l.status !== "claimed").length,
    distinctTokens: new Set(all.map((l) => l.token.toLowerCase())).size,
    claimable: all.filter((l) => l.status === "claimable").length,
    unlockingSoon: all.filter((l) => l.status === "locked" && new Date(l.unlockTime).getTime() <= week).length,
  };
}
