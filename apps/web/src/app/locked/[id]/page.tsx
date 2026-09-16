import Link from "next/link";
import { notFound } from "next/navigation";
import { ARC_TOKEN_LOCKER } from "@arch/chain-config";
import { lockById } from "@/lib/locks";
import { formatAmount, LockStatusChip } from "@/components/LockTable";
import { ClaimLockButton } from "@/components/ClaimLockButton";
import { CopyButton } from "@/components/CopyButton";
import { getChain, explorerAddress, explorerTx, explorerToken } from "@/lib/chains";

/**
 * One lock, in full.
 *
 * This page is the artefact a lock exists to produce: a public, linkable record
 * of who locked what, for whom, until when, and whether it has been collected.
 * Everything on it is either from the chain or derived from it, and every
 * address is copyable and linked, because the whole point is that somebody
 * sceptical can check.
 */

export const dynamic = "force-dynamic";

interface Props {
  readonly params: Promise<{ id: string }>;
}

export default async function LockDetailPage({ params }: Props) {
  const { id } = await params;
  if (!/^[0-9]{1,78}$/.test(id)) notFound();

  const lock = await lockById(id);
  if (lock === null) notFound();

  const chain = getChain("arc");
  const unlock = new Date(lock.unlockTime);
  const created = new Date(lock.createdAt);

  return (
    <div className="stack">
      <header>
        <Link href="/locked" className="arch-note">
          ← All locks
        </Link>
        <div className="spread" style={{ alignItems: "flex-end", flexWrap: "wrap", gap: "var(--s3)", marginTop: "var(--s2)" }}>
          <div>
            <h1 style={{ fontSize: "1.3rem" }}>
              {formatAmount(lock.amount, lock.decimals)} {lock.symbol ?? "tokens"}
            </h1>
            <p className="arch-note" style={{ margin: 0 }}>
              Lock #{lock.lockId}
              {lock.name === null ? null : ` · ${lock.name}`}
            </p>
          </div>
          <LockStatusChip status={lock.status} />
        </div>
      </header>

      <section className="panel" style={{ padding: "var(--s4)" }}>
        <div className="lock-detail-grid">
          <Field label="Token">
            <a href={explorerToken(chain, lock.token)} target="_blank" rel="noreferrer" className="mono">
              {lock.token}
            </a>
            <CopyButton text={lock.token} label="Copy token address" />
          </Field>
          <Field label="Amount">
            <span className="num">
              {formatAmount(lock.amount, lock.decimals)} {lock.symbol ?? ""}
            </span>
            {/* Raw units too: with an unknown token the decimals are a guess,
                and the exact integer is the thing the contract actually holds. */}
            <span className="arch-note num">{lock.amount} base units</span>
          </Field>
          <Field label="Depositor">
            <a href={explorerAddress(chain, lock.depositor)} target="_blank" rel="noreferrer" className="mono">
              {lock.depositor}
            </a>
            <CopyButton text={lock.depositor} label="Copy depositor" />
          </Field>
          <Field label="Recipient">
            <a href={explorerAddress(chain, lock.beneficiary)} target="_blank" rel="noreferrer" className="mono">
              {lock.beneficiary}
            </a>
            <CopyButton text={lock.beneficiary} label="Copy recipient" />
          </Field>
          <Field label="Created">
            <span className="num">{created.toUTCString()}</span>
          </Field>
          <Field label="Unlocks">
            <span className="num">{unlock.toUTCString()}</span>
            <span className="arch-note num">{unlock.toLocaleString()} local</span>
          </Field>
          <Field label="Created in">
            <a href={explorerTx(chain, lock.createdTx)} target="_blank" rel="noreferrer" className="mono">
              {lock.createdTx.slice(0, 18)}…
            </a>
            <span className="arch-note num">block {lock.createdBlock}</span>
          </Field>
          {lock.claimedTx === null ? null : (
            <Field label="Claimed in">
              <a href={explorerTx(chain, lock.claimedTx)} target="_blank" rel="noreferrer" className="mono">
                {lock.claimedTx.slice(0, 18)}…
              </a>
              <span className="arch-note num">
                {lock.claimedAt === null ? "" : new Date(lock.claimedAt).toUTCString()}
              </span>
            </Field>
          )}
          <Field label="Locker">
            <a href={explorerAddress(chain, ARC_TOKEN_LOCKER)} target="_blank" rel="noreferrer" className="mono">
              {ARC_TOKEN_LOCKER}
            </a>
            <CopyButton text={ARC_TOKEN_LOCKER} label="Copy locker address" />
          </Field>
        </div>

        <div style={{ marginTop: "var(--s4)" }}>
          <ClaimLockButton lockId={lock.lockId} beneficiary={lock.beneficiary} status={lock.status} />
        </div>
      </section>

      <p className="arch-note" style={{ maxWidth: 620 }}>
        This lock cannot be cancelled, shortened or withdrawn early by anyone, including Arcanium —
        the contract has no owner and no unlock function. It is unrelated to the permanently locked
        liquidity behind Arcanium markets, which belongs to nobody and never unlocks at all.
      </p>
    </div>
  );
}

function Field({ label, children }: { readonly label: string; readonly children: React.ReactNode }) {
  return (
    <div className="lock-detail-field">
      <div className="arch-stat-label">{label}</div>
      <div style={{ display: "flex", alignItems: "center", gap: "var(--s2)", flexWrap: "wrap", minWidth: 0 }}>
        {children}
      </div>
    </div>
  );
}
