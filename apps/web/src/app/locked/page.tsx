import Link from "next/link";
import { Suspense } from "react";
import { ARC_TOKEN_LOCKER } from "@arch/chain-config";
import { lockList, lockStats } from "@/lib/locks";
import { LockTable } from "@/components/LockTable";
import { MyLocks } from "@/components/MyLocks";
import { CreateLockPanel } from "@/components/CreateLockPanel";
import { Sk } from "@/components/Skeletons";
import { getChain, explorerAddress } from "@/lib/chains";

/**
 * Token locks.
 *
 * Public by default, and that is the point: a lock is only worth making if a
 * stranger can verify it. All Locks is therefore the landing tab and needs no
 * wallet; the wallet-scoped views are tabs off it rather than the other way
 * round.
 *
 * Not to be confused with the permanently locked launch liquidity every
 * Arcanium market has. That liquidity belongs to nobody and never unlocks;
 * these are ordinary allocation locks with an owner and an end date. The copy
 * says so wherever the two could be mistaken for each other.
 */

export const dynamic = "force-dynamic";

const TABS = [
  { key: "all", label: "All locks" },
  { key: "mine", label: "My locks" },
  { key: "claimable", label: "Claimable" },
  { key: "new", label: "Lock a token" },
] as const;

type TabKey = (typeof TABS)[number]["key"];

interface Props {
  readonly searchParams: Promise<{ tab?: string }>;
}

export default async function LockedPage({ searchParams }: Props) {
  const sp = await searchParams;
  const tab: TabKey = TABS.some((t) => t.key === sp.tab) ? (sp.tab as TabKey) : "all";
  const chain = getChain("arc");

  return (
    <div className="stack">
      <header className="spread" style={{ alignItems: "flex-end", flexWrap: "wrap", gap: "var(--s4)" }}>
        <div>
          <h1>Locked</h1>
          <p className="arch-note" style={{ maxWidth: 520 }}>
            Lock any Arc token until a date you choose. The contract has no owner and no admin
            unlock, so nobody can shorten a lock once it exists — not the depositor, not the
            recipient, not Arcanium.
          </p>
        </div>
        {tab === "new" ? null : (
          <Link href="/locked?tab=new" className="btn btn-primary">
            Lock a token
          </Link>
        )}
      </header>

      <Suspense fallback={<Sk h={72} />}>
        <Stats />
      </Suspense>

      <nav className="arch-pills" style={{ display: "inline-flex", flexWrap: "wrap" }}>
        {TABS.map((t) => (
          <Link
            key={t.key}
            href={t.key === "all" ? "/locked" : `/locked?tab=${t.key}`}
            className={tab === t.key ? "arch-pill arch-pill-active" : "arch-pill"}
            aria-current={tab === t.key ? "page" : undefined}
          >
            {t.label}
          </Link>
        ))}
      </nav>

      {tab === "new" ? (
        <CreateLockPanel />
      ) : tab === "all" ? (
        <Suspense fallback={<Sk h={240} />}>
          <AllLocks />
        </Suspense>
      ) : (
        <MyLocks mode={tab === "claimable" ? "claimable" : "mine"} />
      )}

      <p className="arch-note">
        Locker contract{" "}
        <a href={explorerAddress(chain, ARC_TOKEN_LOCKER)} target="_blank" rel="noreferrer" className="mono">
          {ARC_TOKEN_LOCKER}
        </a>
        . Separate from the permanently locked liquidity behind every Arcanium market, which
        belongs to nobody and never unlocks.
      </p>
    </div>
  );
}

async function Stats() {
  const stats = await lockStats();
  if (stats === null) {
    return (
      <p className="arch-note">
        Lock data needs the indexer, which is not currently caught up. Locks themselves are
        unaffected — they live in the contract.
      </p>
    );
  }
  return (
    <div className="arch-stat-bar">
      <Stat label="Active locks" value={stats.activeLocks.toLocaleString("en-US")} />
      <Stat label="Tokens locked" value={stats.distinctTokens.toLocaleString("en-US")} />
      <Stat label="Claimable now" value={stats.claimable.toLocaleString("en-US")} />
      <Stat label="Unlocking in 7d" value={stats.unlockingSoon.toLocaleString("en-US")} />
    </div>
  );
}

async function AllLocks() {
  const result = await lockList({ limit: 100 });
  if (result === null) {
    return <p className="arch-note">Lock data is not available right now.</p>;
  }
  return (
    <div className="panel">
      <LockTable
        locks={result.locks}
        empty="No locks have been created yet. The first one sets the tone."
      />
    </div>
  );
}

function Stat({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div>
      <div className="arch-stat-label">{label}</div>
      <div className="arch-stat-value">{value}</div>
    </div>
  );
}
