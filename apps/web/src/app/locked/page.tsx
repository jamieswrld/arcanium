import Link from "next/link";
import { Suspense } from "react";
import { ARC_TOKEN_LOCKER } from "@arch/chain-config";
import { lockListResilient, lockStatsResilient } from "@/lib/locks";
import type { Hex } from "viem";
import { arcPublicClient } from "@/lib/launchpad";
import { EcoLocks, aggregateByToken, type EcoRow } from "@/components/EcoLocks";
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
  { key: "new", label: "Lock" },
  { key: "mine", label: "Your locks" },
  { key: "eco", label: "Eco Tokens Locked" },
] as const;

type TabKey = (typeof TABS)[number]["key"];

interface Props {
  readonly searchParams: Promise<{ tab?: string; token?: string }>;
}

export default async function LockedPage({ searchParams }: Props) {
  const sp = await searchParams;
  // Locking is the landing tab: most people arrive here to make a lock, and
  // the read-only views are one click away. A legacy ?tab=all or ?tab=claimable
  // link still resolves rather than 404-ing into the wrong view.
  const raw = sp.tab === "all" ? "eco" : sp.tab === "claimable" ? "mine" : sp.tab;
  const tab: TabKey = TABS.some((t) => t.key === raw) ? (raw as TabKey) : "new";
  // Linked from a token page. Validated here rather than passed through, so a
  // malformed address becomes "all locks" instead of a failed query.
  const token = /^0x[0-9a-fA-F]{40}$/.test(sp.token ?? "") ? sp.token?.toLowerCase() : undefined;
  const chain = getChain("arc");

  return (
    <div className="stack">
      <header className="spread" style={{ alignItems: "flex-end", flexWrap: "wrap", gap: "var(--s4)" }}>
        <div>
          <h1>Lock</h1>
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
            href={t.key === "new" ? "/locked" : `/locked?tab=${t.key}`}
            className={tab === t.key ? "arch-pill arch-pill-active" : "arch-pill"}
            aria-current={tab === t.key ? "page" : undefined}
          >
            {t.label}
          </Link>
        ))}
      </nav>

      {tab === "new" ? (
        <CreateLockPanel />
      ) : tab === "eco" ? (
        <Suspense fallback={<Sk h={240} />}>
          <Ecosystem token={token} />
        </Suspense>
      ) : (
        <MyLocks mode="mine" />
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
  const stats = await lockStatsResilient();
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

async function Ecosystem({ token }: { readonly token?: string | undefined }) {
  const result = await lockListResilient({ limit: 200, token });
  if (result === null) {
    return <p className="arch-note">Lock data is not available right now.</p>;
  }

  const rows = aggregateByToken(result.locks, new Set());
  // The indexer only knows the metadata of tokens Arcanium launched, so every
  // other one arrives as a bare address with no decimals. Reading them from
  // chain is what makes this an ecosystem view rather than a list of hashes.
  const enriched = await enrichExternal(rows);

  return (
    <div className="stack">
      <EcoLocks rows={enriched} />
      <p className="arch-note">
        Every token held in the locker, including ones launched somewhere other than Arcanium —
        it accepts any Arc ERC-20. Amounts count only locks still held, so a token cannot inflate
        this by locking and unlocking the same balance.
      </p>
    </div>
  );
}

/** Fill in name, symbol and decimals for tokens the indexer does not know. */
async function enrichExternal(rows: readonly EcoRow[]): Promise<EcoRow[]> {
  const unknown = rows.filter((r) => r.decimals === null).slice(0, 40);
  if (unknown.length === 0) return [...rows];

  const client = arcPublicClient();
  const meta = new Map<string, { symbol: string | null; name: string | null; decimals: number | null }>();

  await Promise.all(
    unknown.map(async (r) => {
      const [symbol, name, decimals] = await Promise.all([
        client.readContract({ address: r.token as Hex, abi: erc20InfoAbi, functionName: "symbol" }).catch(() => null),
        client.readContract({ address: r.token as Hex, abi: erc20InfoAbi, functionName: "name" }).catch(() => null),
        client.readContract({ address: r.token as Hex, abi: erc20InfoAbi, functionName: "decimals" }).catch(() => null),
      ]);
      meta.set(r.token, {
        symbol: typeof symbol === "string" ? symbol : null,
        name: typeof name === "string" ? name : null,
        decimals: typeof decimals === "number" ? decimals : null,
      });
    }),
  );

  return rows.map((r) => {
    const m = meta.get(r.token);
    if (m === undefined) return r;
    return { ...r, symbol: r.symbol ?? m.symbol, name: r.name ?? m.name, decimals: r.decimals ?? m.decimals };
  });
}

const erc20InfoAbi = [
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "name", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
] as const;

function Stat({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div>
      <div className="arch-stat-label">{label}</div>
      <div className="arch-stat-value">{value}</div>
    </div>
  );
}
