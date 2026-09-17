"use client";

import { useEffect, useRef, useState } from "react";
import type { Hex } from "viem";

/**
 * Where a launch's creator fees go: a wallet, or an X account.
 *
 * Wallet is the default and behaves exactly as it always has. The X option
 * exists so somebody can launch a token whose fees belong to an account whose
 * wallet nobody knows yet — the fees accrue at a deterministic address and wait
 * until whoever controls that X account comes to claim them.
 *
 * The handle is resolved server-side before it can be used, and the resolved
 * *numeric* id is what the vault is bound to. If it cannot be resolved the
 * launch does not proceed: binding a fee stream to an identity we could not
 * confirm exists is the one mistake here with no recovery, since the recipient
 * is immutable once the token is launched.
 *
 * This is separate from the token's X link under social links. That is a label
 * on the token; this decides who gets paid.
 */

export interface ResolvedX {
  readonly id: string;
  readonly username: string;
  readonly name: string;
  readonly verified: boolean;
  readonly profileImageUrl: string | null;
  readonly xUserIdHash: Hex;
  /** Where fees will accrue. Real before the contract exists. */
  readonly vault: Hex;
}

export type FeeDestination =
  | { readonly kind: "wallet"; readonly address: string }
  | { readonly kind: "x"; readonly resolved: ResolvedX };

export function CreatorFeeDestination({
  walletAddress,
  tokenXHandle,
  disabled,
  onChange,
}: {
  readonly walletAddress: string;
  /** The handle entered under social links, offered as a shortcut. */
  readonly tokenXHandle: string;
  readonly disabled: boolean;
  readonly onChange: (d: FeeDestination | null) => void;
}) {
  const [tab, setTab] = useState<"wallet" | "x" | "github">("wallet");
  const [ghEnabled, setGhEnabled] = useState(false);
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [reason, setReason] = useState<string | null>(null);
  const [wallet, setWallet] = useState("");
  const [handle, setHandle] = useState("");
  const [resolved, setResolved] = useState<ResolvedX | null>(null);
  const [resolving, setResolving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Ask whether the feature works at all rather than assuming. A missing
  // credential should hide the option, not fail at the launch transaction.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/x/config", { cache: "no-store" });
        const body = (await res.json()) as {
          data?: { enabled?: boolean; github?: boolean; reason?: string | null };
        };
        if (cancelled) return;
        setEnabled(body.data?.enabled === true);
        setGhEnabled(body.data?.github === true);
        setReason(body.data?.reason ?? null);
      } catch {
        if (!cancelled) setEnabled(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * Report upward.
   *
   * The callback is held in a ref and kept out of the dependency array, which
   * is not a lint dodge — it is the whole fix. This effect calls the parent,
   * the parent stores the result in state, and the parent re-renders. A parent
   * that passes an inline arrow (the natural way to write it, and what the
   * launch form did) hands down a new function identity on that re-render, so
   * with `onChange` as a dependency the effect fires again, and again: the
   * value it reports is a freshly built object every time, so React never
   * bails out on an unchanged state. That is an unbounded loop with a setState
   * in it, and because this component sits inside a <details> — mounted even
   * while collapsed — it started on page load and locked the tab up before
   * anyone touched the form.
   *
   * Depending only on the values means the effect fires when the destination
   * actually changes, which is what it was always meant to express.
   *
   * Wallet mode with an empty box means "the wallet I launch with", which is
   * what the contract already does with the zero address.
   */
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    if (tab === "wallet") {
      onChangeRef.current({ kind: "wallet", address: wallet.trim() });
    } else {
      onChangeRef.current(resolved === null ? null : { kind: "x", resolved });
    }
  }, [tab, wallet, resolved]);

  // Re-resolving on a platform switch would be wrong in a quiet way: the vault
  // address differs per platform, so a stale one from the other tab would name
  // somebody else's vault as the fee recipient.
  useEffect(() => {
    setResolved(null);
    setError(null);
  }, [tab]);

  async function resolve(name: string): Promise<void> {
    const platform = tab === "github" ? "github" : "x";
    const clean = name.trim().replace(/^@/, "");
    if (clean === "") return;
    setResolving(true);
    setError(null);
    setResolved(null);
    try {
      // One endpoint for both. It derives the vault from the platform and the
      // handle together, which is what keeps X's @alice and GitHub's alice
      // from sharing an address.
      const res = await fetch(
        `/api/x/vault?platform=${platform}&username=${encodeURIComponent(clean)}`,
        { cache: "no-store" },
      );
      const body = (await res.json()) as {
        data?: { vault?: Hex; username?: string; xUserId?: string | null; identityKey?: Hex };
        error?: { message?: string };
      };
      if (!res.ok || body.data?.vault === undefined) {
        setError(body.error?.message ?? `Could not use ${clean}.`);
        return;
      }
      setResolved({
        id: body.data.xUserId ?? "",
        username: body.data.username ?? clean,
        name: body.data.username ?? clean,
        verified: false,
        profileImageUrl: null,
        xUserIdHash: body.data.identityKey ?? ("0x" as Hex),
        vault: body.data.vault,
      });
    } catch {
      setError("Could not reach the network right now.");
    } finally {
      setResolving(false);
    }
  }

  const walletValid = wallet.trim() === "" || /^0x[0-9a-fA-F]{40}$/.test(wallet.trim());

  return (
    <div className="fee-dest">
      <div className="arch-stat-label">Creator fee destination</div>

      <div className="arch-pills" style={{ display: "inline-flex", marginTop: 6 }}>
        <button
          type="button"
          className={tab === "wallet" ? "arch-pill arch-pill-active" : "arch-pill"}
          style={{ border: "none", cursor: "pointer" }}
          onClick={() => setTab("wallet")}
          disabled={disabled}
        >
          Wallet
        </button>
        <button
          type="button"
          className={tab === "x" ? "arch-pill arch-pill-active" : "arch-pill"}
          style={{ border: "none", cursor: disabled || enabled === false ? "not-allowed" : "pointer" }}
          onClick={() => enabled === true && setTab("x")}
          disabled={disabled || enabled !== true}
          title={enabled === false ? (reason ?? "Not available") : undefined}
        >
          X account
        </button>
        <button
          type="button"
          className={tab === "github" ? "arch-pill arch-pill-active" : "arch-pill"}
          style={{ border: "none", cursor: disabled || !ghEnabled ? "not-allowed" : "pointer" }}
          onClick={() => ghEnabled && setTab("github")}
          disabled={disabled || !ghEnabled}
          title={ghEnabled ? undefined : "GitHub payouts are not configured here"}
        >
          GitHub
        </button>
      </div>

      {tab === "wallet" ? (
        <div style={{ marginTop: "var(--s2)" }}>
          <input
            className="arch-input mono"
            value={wallet}
            onChange={(e) => setWallet(e.target.value)}
            placeholder={`${walletAddress.slice(0, 10)}… (your wallet)`}
            spellCheck={false}
            disabled={disabled}
          />
          <span className="arch-note">
            {walletValid
              ? "Rewards for this token are paid here forever. Leave blank to use the wallet you launch with."
              : "That is not a valid 0x address."}
          </span>
        </div>
      ) : (
        <div style={{ marginTop: "var(--s2)", display: "grid", gap: 6 }}>
          <div style={{ display: "flex", gap: "var(--s2)", flexWrap: "wrap" }}>
            <input
              className="arch-input"
              value={handle}
              onChange={(e) => {
                setHandle(e.target.value);
                setResolved(null);
              }}
              placeholder={tab === "github" ? "username" : "@username"}
              spellCheck={false}
              disabled={disabled || resolving}
              style={{ flex: "1 1 200px" }}
            />
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => void resolve(handle)}
              disabled={disabled || resolving || handle.trim() === ""}
            >
              {resolving ? "Checking…" : "Verify"}
            </button>
          </div>

          {tokenXHandle.trim() !== "" && tokenXHandle.trim().replace(/^@/, "") !== handle.trim().replace(/^@/, "") ? (
            <button
              type="button"
              className="arch-note"
              style={{ background: "none", border: "none", padding: 0, cursor: "pointer", textAlign: "left", color: "var(--accent)" }}
              onClick={() => {
                const h = tokenXHandle.trim().replace(/^@/, "");
                setHandle(h);
                void resolve(h);
              }}
            >
              Use the token&apos;s X account (@{tokenXHandle.trim().replace(/^@/, "")})
            </button>
          ) : null}

          {error === null ? null : (
            <span className="arch-note" style={{ color: "var(--negative)" }}>{error}</span>
          )}

          {resolved === null ? null : (
            <div className="fee-dest-resolved">
              <div>
                <strong>@{resolved.username}</strong>
                {resolved.verified ? <span className="chip" style={{ marginLeft: 6 }}>Verified</span> : null}
                <div className="arch-note">{resolved.name}</div>
              </div>
              <div className="arch-note mono" style={{ wordBreak: "break-all" }}>
                Fees accrue at {resolved.vault}
              </div>
              <p className="arch-note" style={{ margin: 0 }}>
                Bound to this account&apos;s permanent X ID, not the handle — if @{resolved.username}{" "}
                changes name, the fees still belong to the same account. Whoever controls it can
                claim them to any wallet by verifying with X.
              </p>
            </div>
          )}

          {enabled === false ? (
            <span className="arch-note">{reason ?? "X payouts are not available on this deployment."}</span>
          ) : null}
        </div>
      )}
    </div>
  );
}
