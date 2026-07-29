"use client";

import { useEffect, useState } from "react";
import { useAccount, usePublicClient, useReadContract, useSignTypedData } from "wagmi";
import { ConnectButton } from "@/components/ConnectButton";
import type { Hex } from "viem";
import {
  arcTestnet,
  AUSD_ADDRESS,
  erc20Abi,
  formatQuoteUnits,
} from "@/lib/bridgeClient";

const STATION = process.env["NEXT_PUBLIC_ARCH_GAS_STATION_ADDRESS"] as Hex | undefined;

interface GasQuote {
  readonly actionId: number;
  readonly nativeOut: string;
  readonly aUsdIn: string;
  readonly networkFee: string;
  readonly serviceMargin: string;
  readonly expiresAt: string;
  readonly chainId: string;
  readonly permitSpender: Hex;
}

type GasFlow =
  | { readonly step: "idle" }
  | { readonly step: "quoting" }
  | { readonly step: "quoted"; readonly quote: GasQuote }
  | { readonly step: "signing"; readonly quote: GasQuote }
  | { readonly step: "submitting"; readonly quote: GasQuote }
  | { readonly step: "done"; readonly txHash: string; readonly explorer: string }
  | { readonly step: "error"; readonly message: string };

const ACTIONS = [
  { id: 0, label: "Swap" },
  { id: 1, label: "Token launch" },
  { id: 2, label: "Redemption" },
  { id: 3, label: "Approval" },
] as const;

/** Format native 18-decimal USDC wei as a decimal string (exact). */
function formatNative(wei: bigint): string {
  const whole = wei / 10n ** 18n;
  const frac = wei % 10n ** 18n;
  if (frac === 0n) return whole.toString();
  return `${whole}.${frac.toString().padStart(18, "0").replace(/0+$/, "").slice(0, 8)}`;
}

export function GasWidget() {
  const { address, isConnected } = useAccount();
  const { signTypedDataAsync } = useSignTypedData();
  const arcPublic = usePublicClient({ chainId: arcTestnet.id });

  const [actionId, setActionId] = useState<number>(0);
  const [flow, setFlow] = useState<GasFlow>({ step: "idle" });

  // Auto-fetch the quote as soon as the widget is usable and whenever the
  // action changes, so the amounts populate immediately instead of hiding
  // behind a button that looks like it does nothing.
  useEffect(() => {
    if (STATION === undefined) return;
    void getQuote();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actionId]);

  const ausdBalance = useReadContract({
    address: AUSD_ADDRESS,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: address === undefined ? undefined : [address],
    chainId: arcTestnet.id,
    query: { enabled: address !== undefined && AUSD_ADDRESS !== undefined, refetchInterval: 15_000 },
  });

  async function getQuote(): Promise<void> {
    setFlow({ step: "quoting" });
    try {
      const res = await fetch("/api/gas/quote", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ actionId }),
      });
      if (!res.ok) throw new Error(`quote failed (${res.status})`);
      const quote = (await res.json()) as GasQuote;
      setFlow({ step: "quoted", quote });
    } catch (err) {
      setFlow({ step: "error", message: err instanceof Error ? err.message : "quote failed" });
    }
  }

  async function signAndDrip(quote: GasQuote): Promise<void> {
    if (address === undefined || AUSD_ADDRESS === undefined || arcPublic === undefined) return;
    setFlow({ step: "signing", quote });
    try {
      const nonce = await arcPublic.readContract({
        address: AUSD_ADDRESS,
        abi: [
          { type: "function", name: "nonces", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
        ] as const,
        functionName: "nonces",
        args: [address],
      });
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
      const signature = await signTypedDataAsync({
        domain: {
          name: "Arch USD",
          version: "1",
          chainId: arcTestnet.id,
          verifyingContract: AUSD_ADDRESS,
        },
        types: {
          Permit: [
            { name: "owner", type: "address" },
            { name: "spender", type: "address" },
            { name: "value", type: "uint256" },
            { name: "nonce", type: "uint256" },
            { name: "deadline", type: "uint256" },
          ],
        },
        primaryType: "Permit",
        message: {
          owner: address,
          spender: quote.permitSpender,
          value: BigInt(quote.aUsdIn),
          nonce,
          deadline,
        },
      });
      const r = signature.slice(0, 66) as Hex;
      const s = `0x${signature.slice(66, 130)}` as Hex;
      const v = Number.parseInt(signature.slice(130, 132), 16);

      setFlow({ step: "submitting", quote });
      const res = await fetch("/api/gas/drip", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          user: address,
          actionId: quote.actionId,
          nativeOut: quote.nativeOut,
          ausdIn: quote.aUsdIn,
          deadline: deadline.toString(),
          v,
          r,
          s,
        }),
      });
      const result = (await res.json()) as { txHash?: string; explorer?: string; error?: string };
      if (!res.ok || result.txHash === undefined) {
        throw new Error(result.error ?? `drip failed (${res.status})`);
      }
      setFlow({ step: "done", txHash: result.txHash, explorer: result.explorer ?? "" });
    } catch (err) {
      const message = err instanceof Error ? (err.message.split("\n")[0] ?? "failed") : "failed";
      setFlow({
        step: "error",
        message: message.toLowerCase().includes("rejected") ? "Signature rejected in wallet" : message,
      });
    }
  }

  const quote = flow.step === "quoted" || flow.step === "signing" || flow.step === "submitting" ? flow.quote : null;

  if (STATION === undefined) {
    return <p className="arch-note">The gas station is not yet configured on this deployment.</p>;
  }

  return (
    <div>
      <div className="arch-form-row">
        <label htmlFor="gas-action">What do you need gas for?</label>
        <select
          id="gas-action"
          value={actionId}
          onChange={(e) => {
            setActionId(Number.parseInt(e.target.value, 10));
            setFlow({ step: "idle" });
          }}
        >
          {ACTIONS.map((a) => (
            <option key={a.id} value={a.id}>
              {a.label}
            </option>
          ))}
        </select>
        <span className="arch-note" style={{ marginTop: "0.35rem" }}>
          We top up exactly enough native gas to cover one {ACTIONS[actionId]?.label.toLowerCase()} on Arc — the amounts below update live.
        </span>
      </div>

      <div className="arch-panel">
        <div className="arch-panel-head">
          <span>You pay</span>
          <span className="arch-asset-chip">aUSD</span>
        </div>
        <div className="arch-amount-row">
          <span className="arch-amount-output">
            {quote !== null ? formatQuoteUnits(BigInt(quote.aUsdIn)) : "—"}
          </span>
        </div>
        <div className="arch-panel-foot">
          <span>Balance: {ausdBalance.data !== undefined ? formatQuoteUnits(ausdBalance.data) : "—"} aUSD</span>
        </div>
      </div>

      <div className="arch-panel" style={{ marginTop: "0.75rem" }}>
        <div className="arch-panel-head">
          <span>You receive (gas)</span>
          <span className="arch-asset-chip">USDC</span>
        </div>
        <div className="arch-amount-row">
          <span className="arch-amount-output">
            {quote !== null ? formatNative(BigInt(quote.nativeOut)) : "—"}
          </span>
        </div>
        <div className="arch-panel-foot">
          <span>Native Arc USDC, delivered by the relayer</span>
        </div>
      </div>

      {quote !== null ? (
        <div style={{ padding: "0.75rem 0 0", fontSize: "0.85rem" }}>
          <div style={{ display: "flex", justifyContent: "space-between", padding: "0.2rem 0" }}>
            <span style={{ color: "var(--arch-text-muted)" }}>Network cost component</span>
            <span>{formatQuoteUnits(BigInt(quote.networkFee))} aUSD</span>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", padding: "0.2rem 0" }}>
            <span style={{ color: "var(--arch-text-muted)" }}>Arcanium service margin (5%)</span>
            <span>{formatQuoteUnits(BigInt(quote.serviceMargin))} aUSD</span>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", padding: "0.2rem 0" }}>
            <span style={{ color: "var(--arch-text-muted)" }}>Quote expires</span>
            <span>{new Date(quote.expiresAt).toLocaleTimeString()}</span>
          </div>
        </div>
      ) : null}

      {!isConnected ? (
        <ConnectButton />
      ) : flow.step === "idle" || flow.step === "error" || flow.step === "done" ? (
        <button className="arch-primary-button" style={{ cursor: "pointer", opacity: 1 }} onClick={() => void getQuote()}>
          Get quote
        </button>
      ) : flow.step === "quoting" ? (
        <button className="arch-primary-button" disabled>
          Fetching quote…
        </button>
      ) : flow.step === "quoted" ? (
        <button
          className="arch-primary-button"
          style={{ cursor: "pointer", opacity: 1 }}
          onClick={() => void signAndDrip(flow.quote)}
        >
          Sign permit (free) &amp; receive gas
        </button>
      ) : (
        <button className="arch-primary-button" disabled>
          {flow.step === "signing" ? "Sign in wallet…" : "Relayer submitting…"}
        </button>
      )}

      {flow.step === "done" ? (
        <p className="arch-note" style={{ color: "var(--arch-positive)" }}>
          ✓ Gas delivered.{" "}
          <a href={flow.explorer} target="_blank" rel="noreferrer" style={{ textDecoration: "underline" }}>
            View transaction
          </a>
        </p>
      ) : null}
      {flow.step === "error" ? (
        <p className="arch-note" style={{ color: "var(--arch-negative)" }}>{flow.message}</p>
      ) : null}
    </div>
  );
}
