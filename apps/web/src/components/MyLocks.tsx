"use client";

import { useEffect, useState } from "react";
import { useAccount } from "wagmi";
import type { LockRow } from "@/lib/locks";
import { LockTable } from "@/components/LockTable";

/**
 * The wallet-scoped lock tabs.
 *
 * A client component because the answer depends on which wallet is connected,
 * which the server does not know. "Mine" deliberately means both sides of a
 * lock — what you created and what is coming to you — because a user thinking
 * about locks does not separate the two, and a lock you made for someone else
 * is still yours to keep track of.
 */

export function MyLocks({ mode }: { readonly mode: "mine" | "claimable" }) {
  const { address, isConnected } = useAccount();
  const [locks, setLocks] = useState<LockRow[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (address === undefined) return undefined;
    let cancelled = false;
    setLocks(null);
    setFailed(false);
    void (async () => {
      try {
        const params = new URLSearchParams({ wallet: address, limit: "100" });
        // Claimable is scoped to the beneficiary: a lock you created for
        // somebody else is not yours to collect, and listing it here would
        // suggest otherwise.
        if (mode === "claimable") {
          params.set("status", "claimable");
          params.set("role", "beneficiary");
        }
        const res = await fetch(`/api/locks?${params.toString()}`, { cache: "no-store" });
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
  }, [address, mode]);

  if (!isConnected || address === undefined) {
    return (
      <div className="panel" style={{ padding: "var(--s4)" }}>
        <p className="arch-note">Connect a wallet to see your locks.</p>
      </div>
    );
  }
  if (failed) {
    return (
      <div className="panel" style={{ padding: "var(--s4)" }}>
        <p className="arch-note">
          Lock data is not available right now. Your locks are unaffected — they live in the
          contract, not here.
        </p>
      </div>
    );
  }
  if (locks === null) return <div className="arch-skeleton" style={{ height: 220 }} />;

  return (
    <div className="panel">
      <LockTable
        locks={locks}
        empty={
          mode === "claimable"
            ? "Nothing to claim yet. Locks appear here the moment they mature."
            : "You have not created or received any locks."
        }
      />
    </div>
  );
}
