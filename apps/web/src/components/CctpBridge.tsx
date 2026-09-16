"use client";

import { useEffect, useMemo, useState } from "react";
import { useAccount, usePublicClient, useReadContract, useSwitchChain, useWriteContract } from "wagmi";
import { base } from "viem/chains";
import type { Hex } from "viem";
import { arcTestnet, erc20Abi, formatQuoteUnits, parseQuoteUnits } from "@/lib/bridgeClient";
import { ARC, BRIDGE_CHAINS, bridgeChainByKey, type BridgeChain } from "@/lib/bridgeChains";
import { ChainPicker } from "@/components/ChainPicker";
import {
  addressToBytes32,
  BRIDGE_FEE_BPS,
  bridgeRouterAbi,
  FAST_FINALITY,
  maxFeeFor,
  TOKEN_MESSENGER_V2,
  tokenMessengerAbi,
  tokenMessengerMinterAbi,
  tokenMinterAbi,
} from "@/lib/cctp";
import { UsdcLogo } from "@/components/UsdcLogo";
import { ConnectButton } from "@/components/ConnectButton";
import { useToast } from "@/components/ui/Toast";



type Phase = "idle" | "switching" | "approving" | "burning" | "attesting" | "claiming" | "done" | "error";

interface Pending {
  readonly burnTx: Hex;
  /** Registry keys. Older saved transfers only had a binary direction; see
   *  loadPending, which upgrades them rather than dropping an in-flight
   *  deposit somebody's money is sitting in. */
  readonly from: string;
  readonly to: string;
  readonly amount: string; // 6d units
  readonly at: number;
}

const STORE_KEY = "arcanium.bridge.pending";

function loadPending(): Pending | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORE_KEY);
    if (raw === null) return null;
    const p = JSON.parse(raw) as Pending & { direction?: string };
    if (!/^0x[0-9a-fA-F]{64}$/.test(p.burnTx)) return null;
    // Transfers saved before the bridge became multi-chain carry a binary
    // direction instead of keys. Dropping those would strand an in-flight
    // deposit that somebody's money is sitting in, so they are upgraded.
    if (p.from === undefined || p.to === undefined) {
      const toArc = p.direction !== "toBase";
      return { ...p, from: toArc ? "base" : "arc", to: toArc ? "arc" : "base" };
    }
    return p;
  } catch {
    return null;
  }
}
function savePending(p: Pending | null): void {
  if (typeof window === "undefined") return;
  if (p === null) window.localStorage.removeItem(STORE_KEY);
  else window.localStorage.setItem(STORE_KEY, JSON.stringify(p));
}

function Spinner() {
  return (
    <span
      aria-hidden
      style={{
        width: 15, height: 15, borderRadius: 999, display: "inline-block",
        border: "2px solid oklch(1 0 0 / 0.35)", borderTopColor: "#fff",
        animation: "spin 0.75s linear infinite", marginRight: "0.5rem", verticalAlign: "-2px",
      }}
    />
  );
}

/** One row of the transfer checklist: done ✓ / active spinner / waiting dot. */
function Step({ state, title, note }: { readonly state: "done" | "active" | "todo"; readonly title: string; readonly note: string }) {
  return (
    <div style={{ display: "flex", gap: "0.6rem", alignItems: "flex-start", padding: "0.4rem 0" }}>
      <span
        aria-hidden
        style={{
          width: 18, height: 18, borderRadius: 999, flexShrink: 0, marginTop: 1,
          display: "grid", placeItems: "center", fontSize: "0.62rem", fontWeight: 700,
          background: state === "done" ? "var(--positive)" : state === "active" ? "var(--brand-gradient)" : "var(--muted)",
          color: state === "todo" ? "var(--muted-foreground)" : "#fff",
          border: state === "todo" ? "1px solid var(--border)" : "none",
        }}
      >
        {state === "done" ? "✓" : state === "active" ? "•" : ""}
      </span>
      <span style={{ minWidth: 0 }}>
        <span style={{ display: "block", fontSize: "0.85rem", fontWeight: 600, color: state === "todo" ? "var(--muted-foreground)" : "var(--foreground)" }}>
          {title}
        </span>
        <span className="arch-note" style={{ fontSize: "0.75rem" }}>{note}</span>
      </span>
    </div>
  );
}

/**
 * Circle CCTP v2 bridge: burn USDC on the source chain, Circle attests, our
 * relayer claims on the destination — arrival needs no gas there. The pending
 * transfer is persisted, so closing the tab mid-flight never loses it: the
 * claim can always be resumed (it never creates a second deposit).
 */
export function CctpBridge() {
  const { address, isConnected, chainId } = useAccount();
  const { switchChainAsync } = useSwitchChain();
  const { writeContractAsync } = useWriteContract();
  // One client, following the selected source. usePublicClient is a hook so the
  // chain id has to come from state rather than be chosen per call site.
  const { toast } = useToast();

  // Default route: the one almost everyone wants, funding Arc to trade.
  const [fromKey, setFromKey] = useState<string>("base");
  const [toKey, setToKey] = useState<string>("arc");
  const [amountText, setAmountText] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [claimTx, setClaimTx] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [fastFeeBps, setFastFeeBps] = useState<number | null>(null);
  const [burnLimit, setBurnLimit] = useState<bigint | null>(null);

  // Circle's live fast-lane fee for this route (bps). Determines the maxFee
  // we must allow for fast finality to engage.
  useEffect(() => {
    const srcD = bridgeChainByKey(fromKey)?.domain;
    const dstD = bridgeChainByKey(toKey)?.domain;
    if (srcD === undefined || dstD === undefined) return undefined;
    let cancelled = false;
    fetch(`/api/bridge/fee?src=${srcD}&dst=${dstD}`)
      .then((r) => r.json())
      .then((d: { fastMinimumFee?: number | null }) => {
        if (!cancelled && typeof d.fastMinimumFee === "number") setFastFeeBps(d.fastMinimumFee);
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [fromKey, toKey]);

  // Restore an in-flight transfer on mount.
  useEffect(() => {
    const p = loadPending();
    if (p !== null) {
      setPending(p);
      setFromKey(p.from);
      setToKey(p.to);
      setPhase("attesting");
    }
  }, []);

  // Elapsed timer while waiting on Circle.
  useEffect(() => {
    if (phase !== "attesting" || pending === null) return;
    const t = setInterval(() => setElapsed(Math.round((Date.now() - pending.at) / 1000)), 1000);
    return () => clearInterval(t);
  }, [phase, pending]);

  const src: BridgeChain = bridgeChainByKey(fromKey) ?? ARC;
  const dst: BridgeChain = bridgeChainByKey(toKey) ?? ARC;
  const srcChainId = src.chainId;
  const srcName = src.name;
  const dstName = dst.name;
  const srcUsdc = src.usdc;
  const srcExplorer = src.explorer;
  const dstExplorer = dst.explorer;

  /**
   * What the deposit is sent to.
   *
   * Where Arcanium has a router deployed it is used, and takes the protocol
   * fee. Everywhere else the burn goes straight to CCTP's TokenMessenger: a
   * route that works and earns nothing is worth more than a route that does
   * not exist, and deploying a router to eleven chains to collect a fee on
   * traffic that does not exist yet would be the wrong order to do things in.
   */
  const srcRouter = src.router ?? TOKEN_MESSENGER_V2;
  const viaRouter = src.router !== undefined;

  // Reads go to the source chain whichever one is selected.
  const srcPublic = usePublicClient({ chainId: src.chainId });

  // Circle's per-transaction burn cap on the source chain. Arc's outbound cap
  // is tiny today, so surface it before the user signs instead of reverting.
  useEffect(() => {
    if (srcPublic === undefined) return undefined;
    let cancelled = false;
    (async () => {
      const minter = await srcPublic.readContract({ address: TOKEN_MESSENGER_V2, abi: tokenMessengerMinterAbi, functionName: "localMinter" });
      const lim = await srcPublic.readContract({ address: minter, abi: tokenMinterAbi, functionName: "burnLimitsPerMessage", args: [src.usdc] });
      if (!cancelled) setBurnLimit(lim);
    })().catch(() => { if (!cancelled) setBurnLimit(null); });
    return () => { cancelled = true; };
  }, [srcPublic, src.usdc]);


  // Read per selected chain rather than for a fixed pair, so adding a chain to
  // the registry needs no change here.
  const srcBal = useReadContract({
    address: src.usdc, abi: erc20Abi, functionName: "balanceOf",
    args: address === undefined ? undefined : [address],
    chainId: src.chainId,
    query: { enabled: address !== undefined, refetchInterval: 10_000 },
  });
  const dstBal = useReadContract({
    address: dst.usdc, abi: erc20Abi, functionName: "balanceOf",
    args: address === undefined ? undefined : [address],
    chainId: dst.chainId,
    query: { enabled: address !== undefined, refetchInterval: 10_000 },
  });
  const srcBalance = srcBal.data;
  const dstBalance = dstBal.data;

  const parsed = useMemo<bigint | null>(() => {
    if (amountText.trim() === "") return null;
    try { return parseQuoteUnits(amountText); } catch { return null; }
  }, [amountText]);

  const platformFee = parsed === null || !viaRouter ? 0n : (parsed * BRIDGE_FEE_BPS) / 10_000n;
  const burnAmount = parsed === null ? 0n : parsed - platformFee;
  // Circle's fee is bps of the burn amount; round up and add a small buffer so
  // a tick of drift can't drop us onto the slow lane.
  const circleMax =
    parsed === null
      ? 0n
      : fastFeeBps === null
        ? maxFeeFor(burnAmount)
        : (() => {
            const scaled = BigInt(Math.ceil(fastFeeBps * 100)); // bps*100 for precision
            const fee = (burnAmount * scaled) / 1_000_000n;
            const withBuffer = fee + fee / 5n + 1n;
            const cap = maxFeeFor(burnAmount); // never exceed the 20bps ceiling
            return withBuffer > cap ? cap : withBuffer;
          })();
  const receiveMin = parsed === null ? null : parsed - platformFee - circleMax;

  const busy = phase === "switching" || phase === "approving" || phase === "burning" || phase === "attesting" || phase === "claiming";

  /** Poll Circle, then have the relayer claim on the destination. */
  async function settle(p: Pending): Promise<void> {
    const srcDomain = bridgeChainByKey(p.from)?.domain ?? ARC.domain;
    const destination = bridgeChainByKey(p.to) ?? ARC;
    setPhase("attesting");
    setMessage(null);
    const deadline = Date.now() + 30 * 60_000; // Base finality can take ~15–20 min
    for (;;) {
      const res = await fetch(`/api/bridge/attest?domain=${srcDomain}&tx=${p.burnTx}`).then((r) => r.json()).catch(() => ({ status: "pending" }));
      if (res.status === "complete") {
        setPhase("claiming");
        const relay = await fetch("/api/bridge/relay", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ chain: destination.key, message: res.message, attestation: res.attestation }),
        }).then((r) => r.json());
        if (relay.txHash === undefined) {
          const already = typeof relay.error === "string" && relay.error.includes("Already minted");
          if (already) {
            savePending(null);
            setPending(null);
            setPhase("done");
            setMessage(`This transfer was already claimed — your USDC is on ${destination.name}.`);
            return;
          }
          setPhase("error");
          setMessage(relay.error ?? "Claim failed. Your deposit is attested and safe — press Resume to retry.");
          return;
        }
        savePending(null);
        setPending(null);
        setClaimTx(relay.txHash);
        setPhase("done");
        void srcBal.refetch();
        void dstBal.refetch();
        toast({ tone: "success", title: `Bridged to ${destination.name}`, description: "Native USDC delivered.", href: `${destination.explorer}/tx/${relay.txHash}`, hrefLabel: "View claim" });
        return;
      }
      if (Date.now() > deadline) {
        setPhase("error");
        setMessage("Circle is still confirming this deposit. Nothing is lost — come back and press Resume to claim.");
        return;
      }
      await new Promise((r) => setTimeout(r, 4_000));
    }
  }

  async function start(): Promise<void> {
    if (address === undefined || parsed === null || parsed === 0n) {
      setPhase("error"); setMessage("Enter an amount."); return;
    }
    if (srcBalance !== undefined && srcBalance < parsed) {
      setPhase("error"); setMessage(`Insufficient USDC on ${srcName}.`); return;
    }
    if (burnLimit !== null && burnLimit > 0n && parsed - (parsed * BRIDGE_FEE_BPS) / 10_000n > burnLimit) {
      setPhase("error");
      setMessage(`Circle caps ${srcName} transfers at ${formatQuoteUnits(burnLimit)} USDC per transaction right now. Send ${formatQuoteUnits(burnLimit)} or less (you can repeat it).`);
      return;
    }
    if (srcPublic === undefined) return;
    setMessage(null);
    setClaimTx(null);
    try {
      if (chainId !== srcChainId) {
        setPhase("switching");
        await switchChainAsync({ chainId: srcChainId });
      }

      const allowance = await srcPublic.readContract({
        address: srcUsdc, abi: erc20Abi, functionName: "allowance", args: [address, srcRouter],
      });
      if (allowance < parsed) {
        setPhase("approving");
        const approveTx = await writeContractAsync({
          address: srcUsdc, abi: erc20Abi, functionName: "approve", args: [srcRouter, parsed], chainId: srcChainId,
        });
        await srcPublic.waitForTransactionReceipt({ hash: approveTx });
      }

      setPhase("burning");
      // Two shapes for the same operation: the router wraps depositForBurn
      // and takes the protocol fee first; without one we call CCTP directly.
      const burnTx = viaRouter
        ? await writeContractAsync({
            address: srcRouter,
            abi: bridgeRouterAbi,
            functionName: "bridge",
            args: [parsed, dst.domain, addressToBytes32(address), circleMax, FAST_FINALITY],
            chainId: srcChainId,
          })
        : await writeContractAsync({
            address: TOKEN_MESSENGER_V2,
            abi: tokenMessengerAbi,
            functionName: "depositForBurn",
            args: [
              parsed,
              dst.domain,
              addressToBytes32(address),
              src.usdc,
              // Empty destinationCaller: anyone may deliver the mint, which
              // is what lets the relayer claim on the user's behalf.
              addressToBytes32("0x0000000000000000000000000000000000000000"),
              circleMax,
              FAST_FINALITY,
            ],
            chainId: srcChainId,
          });
      const receipt = await srcPublic.waitForTransactionReceipt({ hash: burnTx });
      if (receipt.status !== "success") {
        setPhase("error"); setMessage("Deposit transaction reverted."); return;
      }

      const p: Pending = { burnTx, from: fromKey, to: toKey, amount: parsed.toString(), at: Date.now() };
      savePending(p);
      window.dispatchEvent(new Event("arcanium:orders"));
      setPending(p);
      setAmountText("");
      await settle(p);
    } catch (err) {
      const raw = err instanceof Error ? (err.message.split("\n")[0] ?? "failed") : "failed";
      setPhase("error");
      setMessage(raw.toLowerCase().includes("rejected") ? "Rejected in wallet" : raw);
    }
  }

  const stepState = (want: Phase[]): "done" | "active" | "todo" => {
    const order: Phase[] = ["idle", "switching", "approving", "burning", "attesting", "claiming", "done"];
    const cur = order.indexOf(phase === "error" ? "attesting" : phase);
    const mine = Math.max(...want.map((w) => order.indexOf(w)));
    if (phase === "done") return "done";
    if (cur > mine) return "done";
    if (want.includes(phase)) return "active";
    return "todo";
  };

  const buttonLabel = ((): string => {
    switch (phase) {
      case "switching": return `Switch to ${srcName}…`;
      case "approving": return "Approving USDC…";
      case "burning": return `Depositing on ${srcName}…`;
      case "attesting": return `Waiting for Circle${elapsed > 0 ? ` · ${Math.floor(elapsed / 60)}m ${elapsed % 60}s` : ""}…`;
      case "claiming": return `Claiming on ${dstName}…`;
      default: return `Bridge to ${dstName}`;
    }
  })();

  /** Chains selectable on one side. The same chain cannot be both ends. */
  const options = (side: "from" | "to"): readonly BridgeChain[] => {
    const other = side === "from" ? toKey : fromKey;
    return [ARC, ...BRIDGE_CHAINS].filter((c) => c.key !== other);
  };

  const panel = (
    label: string,
    side: "from" | "to",
    balance: bigint | undefined,
    input: boolean,
  ): React.ReactNode => (
    <div className="arch-panel">
      <div className="arch-panel-head">
        <span>{label}</span>
        <span className="arch-chain-chip" style={{ display: "inline-flex", alignItems: "center", gap: "0.4rem" }}>
          <UsdcLogo size={16} /> USDC
          <ChainPicker
            label={`${label} chain`}
            value={side === "from" ? fromKey : toKey}
            disabled={busy}
            options={options(side)}
            onChange={(key) => {
              if (side === "from") setFromKey(key);
              else setToKey(key);
              setPhase("idle");
              setMessage(null);
            }}
          />
        </span>
      </div>
      <div className="arch-amount-row">
        {input ? (
          <input className="arch-amount-input" placeholder="0.00" inputMode="decimal" value={amountText} onChange={(e) => setAmountText(e.target.value)} disabled={busy} aria-label="Amount to bridge" />
        ) : (
          <span className="arch-amount-output">{receiveMin !== null && receiveMin > 0n ? formatQuoteUnits(receiveMin) : "0.00"}</span>
        )}
      </div>
      <div className="arch-panel-foot">
        <span>{input ? "You send" : "You receive (at least)"}</span>
        <span>
          Balance: {balance !== undefined ? formatQuoteUnits(balance) : "—"}
          {input ? (
            <button className="arch-max-chip" style={{ marginLeft: "0.4rem" }} disabled={balance === undefined || busy} onClick={() => { if (balance !== undefined) setAmountText(formatQuoteUnits(balance).replace(/,/g, "")); }}>
              Max
            </button>
          ) : null}
        </span>
      </div>
    </div>
  );

  return (
    <div>
      <style>{"@keyframes spin{to{transform:rotate(360deg)}}"}</style>

      {panel("From", "from", srcBalance, true)}
      <div className="arch-switch-row">
        <button
          className="arch-switch-button"
          aria-label="Switch direction"
          disabled={busy}
          onClick={() => {
            const a = fromKey;
            setFromKey(toKey);
            setToKey(a);
            setPhase("idle");
            setMessage(null);
          }}
        >
          ⇅
        </button>
      </div>
      {panel("To", "to", dstBalance, false)}

      {/* No itemised fee breakdown. The figure that decides anything is what
          lands in your wallet, and the "To" panel already states it as a
          minimum, net of both the platform fee and Circle's. Splitting it into
          line items added rows without adding information. */}
      <div style={{ padding: "0.8rem 0 0.2rem", fontSize: "0.85rem" }}>
        {burnLimit !== null && burnLimit > 0n && burnLimit < 1_000_000_000n ? (
          <div style={{ display: "flex", justifyContent: "space-between", padding: "0.15rem 0" }}>
            <span style={{ color: "var(--muted-foreground)" }}>Circle limit from {srcName}</span>
            <span style={{ color: "var(--warning)" }}>{formatQuoteUnits(burnLimit)} USDC per transfer</span>
          </div>
        ) : null}
        <div style={{ display: "flex", justifyContent: "space-between", padding: "0.15rem 0" }}>
          <span style={{ color: "var(--muted-foreground)" }}>Claim gas on {dstName}</span>
          <span style={{ color: "var(--positive)" }}>Free · Arcanium relays it</span>
        </div>
      </div>

      {burnLimit !== null && burnLimit > 0n && burnLimit <= 10_000_000n ? (
        <div
          role="note"
          style={{ marginTop: "0.85rem", border: "1px solid color-mix(in oklch, var(--warning) 45%, transparent)", background: "color-mix(in oklch, var(--warning) 10%, transparent)", borderRadius: 12, padding: "0.7rem 0.85rem" }}
        >
          <div style={{ fontWeight: 700, fontSize: "0.85rem", color: "var(--warning)" }}>
            Withdrawals from Arc are limited by Circle
          </div>
          <p className="arch-note" style={{ margin: "0.3rem 0 0" }}>
            Circle currently caps CCTP transfers <strong>out of Arc</strong> at{" "}
            {formatQuoteUnits(burnLimit)} USDC per transaction while the chain is new — this is
            Circle&apos;s limit, not Arcanium&apos;s, and it applies to every app on Arc. Bridging{" "}
            <strong>into</strong> Arc is unrestricted. The cap lifts as Circle raises Arc&apos;s limits.
          </p>
        </div>
      ) : null}

      {/* Transfer checklist — always visible so the flow is never a mystery. */}
      <div style={{ border: "1px solid var(--border)", borderRadius: 12, padding: "0.6rem 0.85rem", margin: "0.85rem 0", background: "color-mix(in oklch, var(--background) 45%, var(--card))" }}>
        <Step state={stepState(["approving"])} title="Approve USDC" note={`One-time allowance for the ${srcName} router`} />
        <Step state={stepState(["burning"])} title={`Deposit on ${srcName}`} note="Fee taken, remainder burned via Circle CCTP" />
        <Step state={stepState(["attesting"])} title="Wait for Circle" note="Circle signs the deposit — timing is set by Circle, not Arcanium" />
        <Step state={stepState(["claiming"])} title={`Claim on ${dstName}`} note={`Relayed for you · no ${dstName} gas needed`} />
      </div>

      {!isConnected ? (
        <ConnectButton />
      ) : (
        <button
          className="arch-primary-button"
          style={{ cursor: busy || (parsed === null && pending === null) ? "not-allowed" : "pointer", opacity: busy || (parsed === null && pending === null) ? 0.7 : 1 }}
          disabled={busy || (parsed === null && pending === null)}
          onClick={() => void (pending !== null ? settle(pending) : start())}
        >
          {busy ? <Spinner /> : null}
          {pending !== null && !busy ? "Resume pending claim" : buttonLabel}
        </button>
      )}

      {pending !== null && !busy ? (
        <p className="arch-note" style={{ marginTop: "0.5rem", textAlign: "center" }}>
          You have a deposit of {formatQuoteUnits(BigInt(pending.amount))} USDC waiting to be claimed. Resuming never creates a second deposit.
        </p>
      ) : null}

      {(pending !== null || phase === "done") && (pending?.burnTx !== undefined || claimTx !== null) ? (
        <div className="arch-note" style={{ marginTop: "0.75rem" }}>
          {pending?.burnTx !== undefined ? (
            <div>
              Deposit:{" "}
              <a href={`${srcExplorer}/tx/${pending.burnTx}`} target="_blank" rel="noreferrer" style={{ textDecoration: "underline" }}>
                {pending.burnTx.slice(0, 10)}… ✓
              </a>
            </div>
          ) : null}
          {claimTx !== null ? (
            <div style={{ color: "var(--positive)" }}>
              ✓ Claimed on {dstName}:{" "}
              <a href={`${dstExplorer}/tx/${claimTx}`} target="_blank" rel="noreferrer" style={{ textDecoration: "underline" }}>
                {claimTx.slice(0, 10)}…
              </a>
            </div>
          ) : null}
        </div>
      ) : null}

      {message !== null ? (
        <p className="arch-note" style={{ marginTop: "0.6rem", color: phase === "error" ? "var(--negative)" : "var(--positive)" }}>{message}</p>
      ) : null}

      {phase === "done" && pending === null ? (
        <button className="arch-max-chip" style={{ marginTop: "0.6rem", cursor: "pointer", padding: "0.35rem 0.8rem" }} onClick={() => { setPhase("idle"); setMessage(null); setClaimTx(null); }}>
          Bridge again
        </button>
      ) : null}
    </div>
  );
}
