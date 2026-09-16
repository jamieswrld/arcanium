"use client";

import { useEffect, useMemo, useState } from "react";
import { erc20Abi, isAddress, type Hex } from "viem";
import { useAccount, usePublicClient, useSwitchChain, useWriteContract } from "wagmi";
import { ARC_TOKEN_LOCKER } from "@arch/chain-config";
import { getChain } from "@/lib/chains";
import { ensureChain } from "@/lib/wagmi";

/**
 * Create a token lock.
 *
 * The contract cannot undo a lock, so everything here exists to make the two
 * irreversible choices — the beneficiary and the date — impossible to get wrong
 * by accident. The final unlock time is shown as a real date in both UTC and
 * local before anything is signed, because "1 year" is the kind of phrase people
 * agree to without checking what it resolves to.
 */

const lockerAbi = [
  {
    type: "function",
    name: "createLock",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "beneficiary", type: "address" },
      { name: "unlockTime", type: "uint64" },
    ],
    outputs: [{ type: "uint256" }],
  },
] as const;

const PRESETS = [
  { key: "7d", label: "7 days", seconds: 7 * 86_400 },
  { key: "30d", label: "30 days", seconds: 30 * 86_400 },
  { key: "90d", label: "90 days", seconds: 90 * 86_400 },
  { key: "6m", label: "6 months", seconds: 182 * 86_400 },
  { key: "1y", label: "1 year", seconds: 365 * 86_400 },
  { key: "2y", label: "2 years", seconds: 730 * 86_400 },
] as const;

interface TokenMeta {
  readonly address: Hex;
  readonly symbol: string;
  readonly name: string;
  readonly decimals: number;
  readonly balance: bigint;
}

type Phase = "idle" | "approving" | "locking" | "done" | "error";

/** Parse a decimal string into base units without going through a float. */
function toUnits(value: string, decimals: number): bigint | null {
  const m = /^(\d*)(?:\.(\d*))?$/.exec(value.trim());
  if (m === null) return null;
  const whole = m[1] ?? "";
  const frac = (m[2] ?? "").slice(0, decimals);
  if (whole === "" && frac === "") return null;
  return BigInt(whole || "0") * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0") || "0");
}

function formatUnits(v: bigint, decimals: number): string {
  const whole = v / 10n ** BigInt(decimals);
  const frac = (v % 10n ** BigInt(decimals)).toString().padStart(decimals, "0").replace(/0+$/, "");
  return frac === "" ? whole.toString() : `${whole}.${frac.slice(0, 6)}`;
}

export function CreateLockPanel() {
  const chain = getChain("arc");
  const { address, isConnected, chainId } = useAccount();
  const { switchChainAsync } = useSwitchChain();
  const pub = usePublicClient({ chainId: chain.id });
  const { writeContractAsync } = useWriteContract();

  const [tokenInput, setTokenInput] = useState("");
  const [meta, setMeta] = useState<TokenMeta | null>(null);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [amount, setAmount] = useState("");
  const [recipient, setRecipient] = useState("");
  const [preset, setPreset] = useState<string>("30d");
  const [customDate, setCustomDate] = useState("");
  const [allowance, setAllowance] = useState<bigint>(0n);
  const [approved, setApproved] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [lockedId, setLockedId] = useState<string | null>(null);

  // Default the recipient to the connected wallet, which is what almost every
  // lock wants, while leaving it editable for a vesting-style lock to someone else.
  useEffect(() => {
    if (address !== undefined && recipient === "") setRecipient(address);
  }, [address, recipient]);

  /** Read metadata straight from the contract — this must work for any ERC-20,
   *  not only Arcanium launches. */
  useEffect(() => {
    const raw = tokenInput.trim();
    if (!isAddress(raw) || pub === undefined || address === undefined) {
      setMeta(null);
      setLookupError(null);
      return undefined;
    }
    let cancelled = false;
    void (async () => {
      try {
        const [symbol, name, decimals, balance] = await Promise.all([
          pub.readContract({ address: raw, abi: erc20Abi, functionName: "symbol" }).catch(() => "?"),
          pub.readContract({ address: raw, abi: erc20Abi, functionName: "name" }).catch(() => "Unknown token"),
          pub.readContract({ address: raw, abi: erc20Abi, functionName: "decimals" }).catch(() => 18),
          pub.readContract({ address: raw, abi: erc20Abi, functionName: "balanceOf", args: [address] }),
        ]);
        if (cancelled) return;
        setMeta({ address: raw, symbol: String(symbol), name: String(name), decimals: Number(decimals), balance });
        setLookupError(null);
      } catch {
        if (!cancelled) {
          setMeta(null);
          setLookupError("No ERC-20 found at that address on Arc.");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tokenInput, pub, address]);

  const units = useMemo(
    () => (meta === null ? null : toUnits(amount, meta.decimals)),
    [amount, meta],
  );

  // A new token or a larger amount means the previous approval may no longer
  // cover it, so the step indicator has to fall back to step one.
  useEffect(() => {
    setApproved(false);
  }, [meta?.address, amount]);

  /** The exact second the lock opens. Computed once, shown, then signed. */
  const unlockAt = useMemo(() => {
    if (preset === "custom") {
      if (customDate === "") return null;
      const t = new Date(customDate).getTime();
      return Number.isFinite(t) ? Math.floor(t / 1000) : null;
    }
    const p = PRESETS.find((x) => x.key === preset);
    return p === undefined ? null : Math.floor(Date.now() / 1000) + p.seconds;
  }, [preset, customDate]);

  // Allowance for exactly this token and spender, refreshed whenever either the
  // token or the amount changes.
  useEffect(() => {
    if (meta === null || pub === undefined || address === undefined) return undefined;
    let cancelled = false;
    void (async () => {
      const a = await pub
        .readContract({
          address: meta.address,
          abi: erc20Abi,
          functionName: "allowance",
          args: [address, ARC_TOKEN_LOCKER as Hex],
        })
        .catch(() => 0n);
      // Monotonic: an allowance only ever grows here, so a stale read must not
      // undo what a confirmed approval established.
      if (!cancelled) setAllowance((prev) => (a > prev ? a : prev));
    })();
    return () => {
      cancelled = true;
    };
  }, [meta, pub, address, phase]);

  const needsApproval = units !== null && units > 0n && allowance < units;
  const recipientValid = isAddress(recipient.trim());
  const unlockValid = unlockAt !== null && unlockAt > Math.floor(Date.now() / 1000);
  const amountValid = units !== null && units > 0n && meta !== null && units <= meta.balance;
  const ready = meta !== null && amountValid && recipientValid && unlockValid;

  async function onApprove(): Promise<void> {
    if (meta === null || units === null) return;
    setPhase("approving");
    setMessage(null);
    try {
      await ensureChain("arc", chainId, switchChainAsync);
      // Exactly the amount needed. An unlimited approval to a contract that
      // will hold funds for years is a standing risk with no upside here.
      const hash = await writeContractAsync({
        address: meta.address,
        abi: erc20Abi,
        functionName: "approve",
        args: [ARC_TOKEN_LOCKER as Hex, units],
        chainId: chain.id,
      });
      const receipt = await pub?.waitForTransactionReceipt({ hash });
      if (receipt?.status !== "success") {
        setPhase("error");
        setMessage("The approval transaction reverted.");
        return;
      }
      // Trust the receipt, not a re-read. The allowance refetch goes through a
      // ranked fallback and can land on a node that has not seen this block
      // yet, which left the button stuck on "Approve" after a successful
      // approval — the user had spent gas and nothing appeared to happen.
      setAllowance(units);
      setApproved(true);
      setPhase("idle");
    } catch (err) {
      setPhase("error");
      setMessage(err instanceof Error ? err.message.split("\n")[0] ?? "Approval failed" : "Approval failed");
    }
  }

  async function onLock(): Promise<void> {
    if (meta === null || units === null || unlockAt === null) return;
    setPhase("locking");
    setMessage(null);
    try {
      await ensureChain("arc", chainId, switchChainAsync);
      const hash = await writeContractAsync({
        address: ARC_TOKEN_LOCKER as Hex,
        abi: lockerAbi,
        functionName: "createLock",
        args: [meta.address, units, recipient.trim() as Hex, BigInt(unlockAt)],
        chainId: chain.id,
      });
      const receipt = await pub?.waitForTransactionReceipt({ hash });
      if (receipt?.status !== "success") {
        setPhase("error");
        setMessage("The lock transaction reverted.");
        return;
      }
      // lockId is the first indexed topic of LockCreated.
      const created = receipt.logs.find(
        (l) => l.address.toLowerCase() === ARC_TOKEN_LOCKER.toLowerCase() && l.topics.length > 1,
      );
      setLockedId(created?.topics[1] === undefined ? null : BigInt(created.topics[1]).toString());
      setPhase("done");
    } catch (err) {
      setPhase("error");
      setMessage(err instanceof Error ? err.message.split("\n")[0] ?? "Lock failed" : "Lock failed");
    }
  }

  if (!isConnected) {
    return (
      <div className="panel" style={{ padding: "var(--s4)" }}>
        <p className="arch-note">Connect a wallet to lock tokens.</p>
      </div>
    );
  }

  if (phase === "done") {
    return (
      <div className="panel" style={{ padding: "var(--s4)" }}>
        <h2 className="eyebrow">Locked</h2>
        <p style={{ marginTop: "var(--s2)" }}>
          {meta === null ? "Tokens" : `${amount} ${meta.symbol}`} locked until{" "}
          {unlockAt === null ? "" : new Date(unlockAt * 1000).toUTCString()}.
        </p>
        {lockedId === null ? null : (
          <a className="btn btn-primary" href={`/locked/${lockedId}`} style={{ marginTop: "var(--s3)" }}>
            View lock #{lockedId}
          </a>
        )}
      </div>
    );
  }

  return (
    <div className="panel lock-form">
      <h2 className="eyebrow">Lock a token</h2>

      <label className="lock-field">
        <span className="arch-stat-label">Token</span>
        <input
          className="arch-input mono"
          placeholder="0x… contract address on Arc"
          value={tokenInput}
          onChange={(e) => setTokenInput(e.target.value)}
          spellCheck={false}
        />
        {lookupError === null ? null : <span className="arch-note" style={{ color: "var(--negative)" }}>{lookupError}</span>}
        {meta === null ? null : (
          <span className="arch-note">
            {meta.name} ({meta.symbol}) · balance {formatUnits(meta.balance, meta.decimals)}
          </span>
        )}
      </label>

      <label className="lock-field">
        <span className="arch-stat-label">Amount</span>
        <input
          className="arch-input num"
          placeholder="0.0"
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
        {meta === null ? null : (
          <span className="arch-pills" style={{ display: "inline-flex", marginTop: 6 }}>
            {[25, 50, 75, 100].map((pct) => (
              <button
                key={pct}
                type="button"
                className="arch-pill"
                style={{ border: "none", cursor: "pointer" }}
                onClick={() => setAmount(formatUnits((meta.balance * BigInt(pct)) / 100n, meta.decimals))}
              >
                {pct === 100 ? "MAX" : `${pct}%`}
              </button>
            ))}
          </span>
        )}
        {units !== null && meta !== null && units > meta.balance ? (
          <span className="arch-note" style={{ color: "var(--negative)" }}>More than your balance.</span>
        ) : null}
      </label>

      <label className="lock-field">
        <span className="arch-stat-label">Recipient</span>
        <input
          className="arch-input mono"
          value={recipient}
          onChange={(e) => setRecipient(e.target.value)}
          spellCheck={false}
        />
        <span className="arch-note">
          Only this address can ever withdraw, and it cannot be changed afterwards.
        </span>
      </label>

      <div className="lock-field">
        <span className="arch-stat-label">Locked for</span>
        <div className="arch-pills" style={{ display: "inline-flex", flexWrap: "wrap" }}>
          {PRESETS.map((p) => (
            <button
              key={p.key}
              type="button"
              className={preset === p.key ? "arch-pill arch-pill-active" : "arch-pill"}
              style={{ border: "none", cursor: "pointer" }}
              onClick={() => setPreset(p.key)}
            >
              {p.label}
            </button>
          ))}
          <button
            type="button"
            className={preset === "custom" ? "arch-pill arch-pill-active" : "arch-pill"}
            style={{ border: "none", cursor: "pointer" }}
            onClick={() => setPreset("custom")}
          >
            Custom
          </button>
        </div>
        {preset === "custom" ? (
          <input
            className="arch-input"
            type="datetime-local"
            value={customDate}
            onChange={(e) => setCustomDate(e.target.value)}
            style={{ marginTop: 8 }}
          />
        ) : null}
      </div>

      {/* The resolved date, before anything is signed. A preset is a shorthand
          and this is what it actually means. */}
      {unlockAt === null ? null : (
        <div className="lock-resolved">
          <div className="arch-stat-label">Unlocks</div>
          <div className="num" style={{ fontWeight: 650 }}>
            {new Date(unlockAt * 1000).toLocaleString()}
          </div>
          <div className="arch-note num">{new Date(unlockAt * 1000).toUTCString()}</div>
        </div>
      )}

      <p className="lock-warning">
        This lock cannot be cancelled, shortened or withdrawn before the unlock date — not by you,
        not by the recipient, and not by Arcanium. There is no admin key.
      </p>

      {message === null ? null : (
        <p className="arch-note" style={{ color: "var(--negative)" }}>{message}</p>
      )}

      {/* Two transactions, shown as two steps. The previous version swapped one
          button for another, so a successful approval looked like nothing had
          happened — especially when the allowance re-read lagged a block. */}
      <ol className="lock-steps">
        <li className={needsApproval ? "lock-step lock-step-active" : "lock-step lock-step-done"}>
          <span className="lock-step-n">{needsApproval ? "1" : "✓"}</span>
          <span>
            Approve {meta?.symbol ?? "the token"}
            <span className="arch-note" style={{ display: "block" }}>
              {needsApproval
                ? "Lets the locker move exactly this amount, once."
                : "Approved. The locker can move this amount."}
            </span>
          </span>
          <button
            type="button"
            className="btn btn-secondary"
            disabled={!ready || !needsApproval || phase === "approving"}
            onClick={() => void onApprove()}
          >
            {phase === "approving" ? "Approving…" : needsApproval ? "Approve" : "Done"}
          </button>
        </li>
        <li className={needsApproval ? "lock-step" : "lock-step lock-step-active"}>
          <span className="lock-step-n">2</span>
          <span>
            Create the lock
            <span className="arch-note" style={{ display: "block" }}>
              This is the transaction that actually moves and locks the tokens.
            </span>
          </span>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!ready || needsApproval || phase === "locking"}
            onClick={() => void onLock()}
          >
            {phase === "locking" ? "Locking…" : "Create lock"}
          </button>
        </li>
      </ol>
      {approved && needsApproval ? (
        <p className="arch-note">
          Your approval is confirmed but this amount is larger than it covers — approve again for
          the new amount.
        </p>
      ) : null}
    </div>
  );
}
