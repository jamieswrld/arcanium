import Link from "next/link";
import type { LockRow } from "@/lib/locks";
import { getChain, explorerAddress } from "@/lib/chains";

/**
 * A list of token locks.
 *
 * Shared by the public list, the wallet-scoped tabs and the token page, so the
 * columns are the same everywhere and a lock reads identically wherever it is
 * seen — which matters for something whose purpose is public verification.
 */

/** Whole units, grouped, with decimals applied. */
export function formatAmount(raw: string, decimals: number | null): string {
  const d = decimals ?? 18;
  try {
    const v = BigInt(raw);
    const whole = v / 10n ** BigInt(d);
    const frac = v % 10n ** BigInt(d);
    if (whole === 0n && frac > 0n) {
      // Dust would otherwise render as a flat "0", which reads as nothing
      // locked at all.
      const s = frac.toString().padStart(d, "0").replace(/0+$/, "");
      return `0.${s.slice(0, 6)}`;
    }
    return whole.toLocaleString("en-US");
  } catch {
    return raw;
  }
}

/** "3d 4h", "12m" — short enough for a table cell. */
export function formatRemaining(seconds: number): string {
  if (seconds <= 0) return "—";
  const d = Math.floor(seconds / 86_400);
  const h = Math.floor((seconds % 86_400) / 3_600);
  const m = Math.floor((seconds % 3_600) / 60);
  if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  return `${Math.max(m, 1)}m`;
}

export function LockStatusChip({ status }: { readonly status: LockRow["status"] }) {
  if (status === "claimed") return <span className="chip">Claimed</span>;
  if (status === "claimable") return <span className="chip chip-pos">Claimable</span>;
  return <span className="chip">Locked</span>;
}

const short = (a: string): string => `${a.slice(0, 6)}…${a.slice(-4)}`;

export function LockTable({
  locks,
  empty = "No locks yet.",
}: {
  readonly locks: readonly LockRow[];
  readonly empty?: string;
}) {
  const chain = getChain("arc");
  if (locks.length === 0) return <p className="arch-note">{empty}</p>;

  return (
    <div className="mkt-wrap">
      <table className="mkt">
        <thead>
          <tr>
            <th scope="col">Token</th>
            <th scope="col">Amount</th>
            <th scope="col">Depositor</th>
            <th scope="col">Recipient</th>
            <th scope="col">Unlocks</th>
            <th scope="col">Remaining</th>
            <th scope="col">Status</th>
          </tr>
        </thead>
        <tbody>
          {locks.map((l) => (
            <tr key={l.lockId}>
              <td data-label="Token">
                <Link href={`/locked/${l.lockId}`} className="ident">
                  <span style={{ minWidth: 0 }}>
                    {/* Symbol when Arcanium launched it, address otherwise. An
                        unknown token showing its address is the honest render:
                        a symbol is trivially spoofable, an address is not. */}
                    <span className="ident-name">{l.symbol ?? short(l.token)}</span>
                    {l.name === null ? null : (
                      <span className="ident-sub" style={{ display: "block" }}>{l.name}</span>
                    )}
                  </span>
                </Link>
              </td>
              <td data-label="Amount" className="num">
                {formatAmount(l.amount, l.decimals)}
              </td>
              <td data-label="Depositor" className="mono">
                <a href={explorerAddress(chain, l.depositor)} target="_blank" rel="noreferrer">
                  {short(l.depositor)}
                </a>
              </td>
              <td data-label="Recipient" className="mono">
                <a href={explorerAddress(chain, l.beneficiary)} target="_blank" rel="noreferrer">
                  {short(l.beneficiary)}
                </a>
              </td>
              <td data-label="Unlocks" className="num">
                {new Date(l.unlockTime).toISOString().slice(0, 10)}
              </td>
              <td data-label="Remaining" className="num" style={{ color: "var(--text-secondary)" }}>
                {formatRemaining(l.secondsRemaining)}
              </td>
              <td data-label="Status">
                <LockStatusChip status={l.status} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
