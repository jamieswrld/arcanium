"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useAccount } from "wagmi";
import type { LockRow } from "@/lib/locks";
import { formatAmount, formatRemaining } from "@/components/LockTable";

/**
 * Locks, on the portfolio.
 *
 * A summary and a way through, not a second copy of /locked. The portfolio's
 * job is to answer "where do I stand" at a glance, and the only lock facts that
 * belong at a glance are how many there are and whether any can be collected
 * right now. Everything else is one click away.
 */

export function PortfolioLocks() {
  const { address, isConnected } = useAccount();
  const [locks, setLocks] = useState<LockRow[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (address === undefined) return undefined;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/locks?wallet=${address}&limit=200`, { cache: "no-store" });
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as { data?: LockRow[] };
        if (!cancelled) setLocks(body.data ?? []);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [address]);

  // Nothing to say is better than an empty panel: a user with no locks should
  // not have a section explaining that.
  if (!isConnected || address === undefined || failed) return null;
  if (locks === null || locks.length === 0) return null;

  const mine = address.toLowerCase();
  const created = locks.filter((l) => l.depositor.toLowerCase() === mine);
  const incoming = locks.filter((l) => l.beneficiary.toLowerCase() === mine);
  const claimable = incoming.filter((l) => l.status === "claimable");
  const next = incoming
    .filter((l) => l.status === "locked")
    .sort((a, b) => a.secondsRemaining - b.secondsRemaining)[0];

  return (
    <section>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: "1rem", flexWrap: "wrap" }}>
        <h2 style={{ margin: "0 0 0.75rem", fontSize: "1.5rem", fontWeight: 700, letterSpacing: "-0.02em" }}>
          Your locks
        </h2>
        <Link href="/locked?tab=mine" className="arch-note">
          View all →
        </Link>
      </div>

      <section className="arch-card">
        <div className="pf-locks">
          <Figure label="Created by you" value={String(created.length)} />
          <Figure label="Unlocking to you" value={String(incoming.length)} />
          <Figure
            label="Claimable now"
            value={String(claimable.length)}
            tone={claimable.length > 0 ? "pos" : undefined}
          />
          <Figure
            label="Next unlock"
            value={next === undefined ? "—" : formatRemaining(next.secondsRemaining)}
          />
        </div>

        {claimable.length === 0 ? null : (
          <div className="pf-claimable">
            {claimable.slice(0, 3).map((l) => (
              <Link key={l.lockId} href={`/locked/${l.lockId}`} className="pf-claim-row">
                <span>
                  {formatAmount(l.amount, l.decimals)} {l.symbol ?? "tokens"}
                </span>
                <span className="chip chip-pos">Claim</span>
              </Link>
            ))}
            {claimable.length > 3 ? (
              <Link href="/locked?tab=claimable" className="arch-note">
                and {claimable.length - 3} more
              </Link>
            ) : null}
          </div>
        )}
      </section>
    </section>
  );
}

function Figure({
  label,
  value,
  tone,
}: {
  readonly label: string;
  readonly value: string;
  readonly tone?: "pos" | undefined;
}) {
  return (
    <div>
      <div className="arch-stat-label">{label}</div>
      <div
        className="num"
        style={{ fontWeight: 650, color: tone === "pos" ? "var(--positive)" : undefined }}
      >
        {value}
      </div>
    </div>
  );
}
