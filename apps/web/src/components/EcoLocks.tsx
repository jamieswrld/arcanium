import Link from "next/link";
import type { LockRow } from "@/lib/locks";
import { formatAmount } from "@/components/LockTable";

/**
 * Every token held in the locker, whoever launched it.
 *
 * The locker takes any ERC-20 on Arc, not only Arcanium launches, so this is
 * the ecosystem view: a token from another launchpad locked here shows up
 * beside our own. That is the whole point of the tab — "what is locked on Arc"
 * is a more useful question than "what of ours is locked".
 *
 * Rows are grouped by token rather than listed per lock, because the number
 * that means something is how much of a supply is immobilised, not how many
 * transactions it took to get there.
 *
 * Amounts are summed only over locks that are still held. Adding claimed locks
 * back in would let a token inflate its own figure by locking and unlocking the
 * same balance repeatedly, which is exactly the claim this page exists to make
 * checkable.
 */

export interface EcoRow {
  readonly token: string;
  readonly symbol: string | null;
  readonly name: string | null;
  readonly decimals: number | null;
  /** Launched on Arcanium, as opposed to locked here from somewhere else. */
  readonly native: boolean;
  readonly lockedUnits: bigint;
  readonly activeLocks: number;
  readonly totalLocks: number;
  /** Soonest unlock among locks still held, or null when none are. */
  readonly nextUnlock: number | null;
}

export function aggregateByToken(locks: readonly LockRow[], nativeTokens: ReadonlySet<string>): EcoRow[] {
  const byToken = new Map<string, EcoRow>();

  for (const l of locks) {
    const key = l.token.toLowerCase();
    const held = l.status !== "claimed";
    const prev = byToken.get(key);
    // unlockTime is an ISO-8601 string, not a number of seconds. Number() on
    // it is NaN, which then survives every comparison below and renders as
    // "NaNm" — so it is parsed, and an unparseable value becomes null rather
    // than a number that silently poisons the minimum.
    const parsedMs = Date.parse(l.unlockTime);
    const unlock = Number.isNaN(parsedMs) ? null : Math.floor(parsedMs / 1000);

    if (prev === undefined) {
      byToken.set(key, {
        token: key,
        symbol: l.symbol,
        name: l.name,
        decimals: l.decimals,
        // Membership only. Inferring it from "we know the symbol" was wrong:
        // on the chain-fallback path locks.ts reads the symbol off the ERC-20
        // itself for every token, so every row claimed to be an Arcanium
        // launch and linked to a market page that does not exist.
        native: nativeTokens.has(key),
        lockedUnits: held ? BigInt(l.amount) : 0n,
        activeLocks: held ? 1 : 0,
        totalLocks: 1,
        nextUnlock: held ? unlock : null,
      });
      continue;
    }

    byToken.set(key, {
      ...prev,
      symbol: prev.symbol ?? l.symbol,
      name: prev.name ?? l.name,
      decimals: prev.decimals ?? l.decimals,
      lockedUnits: prev.lockedUnits + (held ? BigInt(l.amount) : 0n),
      activeLocks: prev.activeLocks + (held ? 1 : 0),
      totalLocks: prev.totalLocks + 1,
      nextUnlock:
        held && unlock !== null && (prev.nextUnlock === null || unlock < prev.nextUnlock)
          ? unlock
          : prev.nextUnlock,
    });
  }

  // Most immobilised first, but tokens with nothing still held sink to the
  // bottom regardless of how many locks they once had.
  return [...byToken.values()].sort((a, b) => {
    if (a.activeLocks !== b.activeLocks && (a.activeLocks === 0 || b.activeLocks === 0)) {
      return a.activeLocks === 0 ? 1 : -1;
    }
    return b.totalLocks - a.totalLocks;
  });
}

function untilLabel(unlock: number | null): string {
  if (unlock === null) return "—";
  const secs = unlock - Math.floor(Date.now() / 1000);
  if (secs <= 0) return "Claimable";
  const days = Math.floor(secs / 86_400);
  if (days >= 1) return `${days}d`;
  const hours = Math.floor(secs / 3_600);
  if (hours >= 1) return `${hours}h`;
  return `${Math.max(1, Math.floor(secs / 60))}m`;
}

export function EcoLocks({ rows }: { readonly rows: readonly EcoRow[] }) {
  if (rows.length === 0) {
    return (
      <div className="panel">
        <p className="arch-note" style={{ padding: "var(--s4)" }}>
          Nothing is locked yet. Any Arc token can be, including ones launched elsewhere.
        </p>
      </div>
    );
  }

  return (
    <div className="panel">
      <table className="arch-table">
        <thead>
          <tr>
            <th scope="col">Token</th>
            <th scope="col">Origin</th>
            <th scope="col">Locked</th>
            <th scope="col">Locks</th>
            <th scope="col">Next unlock</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.token}>
              <td data-label="Token">
                {r.native ? (
                  <Link href={`/tokens/${r.token}`} style={{ fontWeight: 650 }}>
                    {r.symbol ?? `${r.token.slice(0, 10)}…`}
                  </Link>
                ) : (
                  <span className="mono" style={{ fontWeight: 650 }}>
                    {r.symbol ?? `${r.token.slice(0, 10)}…${r.token.slice(-6)}`}
                  </span>
                )}
                {r.name === null ? null : (
                  <div className="arch-note" style={{ fontSize: "0.72rem" }}>{r.name}</div>
                )}
              </td>
              <td data-label="Origin">
                <span className="chip">{r.native ? "Arcanium" : "External"}</span>
              </td>
              <td data-label="Locked" className="num" style={{ fontWeight: 650 }}>
                {/* Without decimals the raw integer would be off by orders of
                    magnitude, and a wrong number is worse than no number. */}
                {r.decimals === null ? "—" : formatAmount(r.lockedUnits.toString(), r.decimals)}
              </td>
              <td data-label="Locks" className="num">
                {r.activeLocks}
                {r.totalLocks !== r.activeLocks ? (
                  <span className="arch-note"> / {r.totalLocks}</span>
                ) : null}
              </td>
              <td data-label="Next unlock" className="num">
                {untilLabel(r.nextUnlock)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
