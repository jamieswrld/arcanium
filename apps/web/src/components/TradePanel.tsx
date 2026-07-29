"use client";

import { useEffect, useMemo, useState } from "react";
import { useAccount, useBalance, usePublicClient, useReadContract, useSwitchChain, useWriteContract } from "wagmi";
import type { Hex } from "viem";
import { arcTestnet, erc20Abi, formatQuoteUnits, parseQuoteUnits, ARC_EXPLORER } from "@/lib/bridgeClient";
import { useToast } from "@/components/ui/Toast";
import { ConnectButton } from "@/components/ConnectButton";
import { ROUTER_ADDRESS, routerAbi } from "@/lib/launchpad";

interface TradePanelProps {
  readonly token: Hex;
  readonly pairToken: Hex;
  readonly symbol: string;
}

type TradeState =
  | { readonly step: "idle" }
  | { readonly step: "approving" }
  | { readonly step: "swapping" }
  | { readonly step: "done"; readonly txHash: Hex }
  | { readonly step: "error"; readonly message: string };

/** Format native 18-decimal USDC wei to 4 significant decimals. */
function formatNativeShort(wei: bigint): string {
  const micro = wei / 10n ** 14n; // 4 decimal places
  return `${micro / 10_000n}.${(micro % 10_000n).toString().padStart(4, "0")}`;
}

/** Live estimated gas cost (swap budget × live gas price) and gas balance,
 *  with the inline gas-station fallback when the wallet has no Arc gas. */
function GasRows() {
  const { address } = useAccount();
  const arcPublic = usePublicClient({ chainId: arcTestnet.id });
  const native = useBalance({ address, chainId: arcTestnet.id, query: { refetchInterval: 20_000 } });
  const [gasCost, setGasCost] = useState<bigint | null>(null);

  useEffect(() => {
    if (arcPublic === undefined) return;
    let cancelled = false;
    arcPublic
      .getGasPrice()
      .then((gp) => { if (!cancelled) setGasCost(gp * 400_000n); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [arcPublic]);

  const noGas = native.data !== undefined && gasCost !== null && native.data.value < gasCost;
  return (
    <div style={{ fontSize: "0.85rem", padding: "0.25rem 0" }}>
      <div style={{ display: "flex", justifyContent: "space-between", padding: "0.15rem 0" }}>
        <span style={{ color: "var(--arch-text-muted)" }}>Estimated gas</span>
        <span>{gasCost !== null ? `${formatNativeShort(gasCost)} USDC` : "—"}</span>
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", padding: "0.15rem 0" }}>
        <span style={{ color: "var(--arch-text-muted)" }}>Gas balance</span>
        <span>{native.data !== undefined ? `${formatNativeShort(native.data.value)} USDC` : "—"}</span>
      </div>
      {noGas ? (
        <p className="arch-note" style={{ color: "var(--arch-warning)", margin: "0.25rem 0 0" }}>
          You have no Arc gas — <a href="/gas" style={{ textDecoration: "underline" }}>buy a little with aUSD</a> (gas-free signature), then trade.
        </p>
      ) : null}
    </div>
  );
}

/** Format 18-decimal token units. */
function formatToken18(units: bigint): string {
  const whole = units / 10n ** 18n;
  return whole.toLocaleString("en-US");
}

function parseToken18(value: string): bigint {
  const match = /^(\d+)(?:\.(\d{1,18}))?$/.exec(value.trim());
  if (match === null) throw new SyntaxError("invalid amount");
  return BigInt(match[1] ?? "0") * 10n ** 18n + BigInt((match[2] ?? "").padEnd(18, "0") || "0");
}

/**
 * Buy/sell panel routing directly through the standard Uniswap v3 router at
 * the 1% tier — no extra router fees, ever. Slippage is enforced via
 * amountOutMinimum computed from user settings.
 */
export function TradePanel({ token, pairToken, symbol }: TradePanelProps) {
  const { address, isConnected, chainId } = useAccount();
  const { switchChainAsync } = useSwitchChain();
  const { writeContractAsync } = useWriteContract();
  const arcPublic = usePublicClient({ chainId: arcTestnet.id });
  const { toast } = useToast();

  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [amountText, setAmountText] = useState("");
  const [slippagePct, setSlippagePct] = useState("5");
  const [state, setState] = useState<TradeState>({ step: "idle" });

  const quoteBalance = useReadContract({
    address: pairToken,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: address === undefined ? undefined : [address],
    chainId: arcTestnet.id,
    query: { enabled: address !== undefined, refetchInterval: 15_000 },
  });
  const tokenBalance = useReadContract({
    address: token,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: address === undefined ? undefined : [address],
    chainId: arcTestnet.id,
    query: { enabled: address !== undefined, refetchInterval: 15_000 },
  });

  const parsedAmount = useMemo<bigint | null>(() => {
    if (amountText.trim() === "") return null;
    try {
      return side === "buy" ? parseQuoteUnits(amountText) : parseToken18(amountText);
    } catch {
      return null;
    }
  }, [amountText, side]);

  const busy = state.step === "approving" || state.step === "swapping";

  async function submit(): Promise<void> {
    if (address === undefined || parsedAmount === null || ROUTER_ADDRESS === undefined || arcPublic === undefined) return;
    try {
      if (chainId !== arcTestnet.id) await switchChainAsync({ chainId: arcTestnet.id });
      const tokenIn = side === "buy" ? pairToken : token;
      const tokenOut = side === "buy" ? token : pairToken;

      const allowance = await arcPublic.readContract({
        address: tokenIn,
        abi: erc20Abi,
        functionName: "allowance",
        args: [address, ROUTER_ADDRESS],
      });
      if (allowance < parsedAmount) {
        setState({ step: "approving" });
        const approveTx = await writeContractAsync({
          address: tokenIn,
          abi: erc20Abi,
          functionName: "approve",
          args: [ROUTER_ADDRESS, parsedAmount],
          chainId: arcTestnet.id,
        });
        await arcPublic.waitForTransactionReceipt({ hash: approveTx });
      }

      // Slippage: simulate the swap for the expected output, then bound it.
      setState({ step: "swapping" });
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);
      const { result: expectedOut } = await arcPublic.simulateContract({
        account: address,
        address: ROUTER_ADDRESS,
        abi: routerAbi,
        functionName: "exactInputSingle",
        args: [{
          tokenIn,
          tokenOut,
          fee: 10_000,
          recipient: address,
          deadline,
          amountIn: parsedAmount,
          amountOutMinimum: 0n,
          sqrtPriceLimitX96: 0n,
        }],
      });
      const slippageBps = BigInt(Math.round(Number.parseFloat(slippagePct || "5") * 100));
      const minOut = expectedOut - (expectedOut * slippageBps) / 10_000n;

      const txHash = await writeContractAsync({
        address: ROUTER_ADDRESS,
        abi: routerAbi,
        functionName: "exactInputSingle",
        args: [{
          tokenIn,
          tokenOut,
          fee: 10_000,
          recipient: address,
          deadline,
          amountIn: parsedAmount,
          amountOutMinimum: minOut,
          sqrtPriceLimitX96: 0n,
        }],
        chainId: arcTestnet.id,
      });
      const receipt = await arcPublic.waitForTransactionReceipt({ hash: txHash });
      if (receipt.status !== "success") {
        setState({ step: "error", message: "Swap reverted" });
        return;
      }
      setState({ step: "done", txHash });
      setAmountText("");
      toast({ tone: "success", title: side === "buy" ? `Bought ${symbol}` : `Sold ${symbol}`, description: "Swap confirmed on Arc.", href: `${ARC_EXPLORER}/tx/${txHash}`, hrefLabel: "View transaction" });
    } catch (err) {
      const message = err instanceof Error ? (err.message.split("\n")[0] ?? "failed") : "failed";
      setState({
        step: "error",
        message: message.toLowerCase().includes("rejected") ? "Rejected in wallet" : message,
      });
      toast({ tone: "error", title: message.toLowerCase().includes("rejected") ? "Rejected in wallet" : "Swap failed", description: message.toLowerCase().includes("rejected") ? undefined : message });
    }
  }

  const bal = side === "buy" ? quoteBalance.data : tokenBalance.data;

  return (
    <div>
      <div className="arch-pills" style={{ display: "inline-flex", marginBottom: "0.75rem" }}>
        <button className={side === "buy" ? "arch-pill arch-pill-active" : "arch-pill"} onClick={() => { setSide("buy"); setState({ step: "idle" }); }}>Buy</button>
        <button className={side === "sell" ? "arch-pill arch-pill-active" : "arch-pill"} onClick={() => { setSide("sell"); setState({ step: "idle" }); }}>Sell</button>
      </div>

      <div className="arch-panel">
        <div className="arch-panel-head">
          <span>{side === "buy" ? "You pay" : "You sell"}</span>
          <span className="arch-asset-chip">{side === "buy" ? "aUSD" : symbol}</span>
        </div>
        <div className="arch-amount-row">
          <input className="arch-amount-input" placeholder="0.00" inputMode="decimal" value={amountText} onChange={(e) => setAmountText(e.target.value)} disabled={busy} aria-label="Trade amount" />
        </div>
        <div className="arch-panel-foot">
          <span>Balance: {bal !== undefined ? (side === "buy" ? `${formatQuoteUnits(bal)} aUSD` : `${formatToken18(bal)} ${symbol}`) : "—"}</span>
        </div>
        <div className="arch-pct-chips">
          {[25, 50, 75, 100].map((pct) => (
            <button key={pct} className="arch-pct-chip" disabled={busy || bal === undefined} onClick={() => {
              if (bal === undefined) return;
              const portion = (bal * BigInt(pct)) / 100n;
              setAmountText(side === "buy" ? formatQuoteUnits(portion).replace(/,/g, "") : (portion / 10n ** 18n).toString());
            }}>{pct === 100 ? "Max" : `${pct}%`}</button>
          ))}
        </div>
      </div>

      <div className="arch-form-row" style={{ marginTop: "0.75rem" }}>
        <label htmlFor="trade-slippage">Slippage tolerance (%)</label>
        <input id="trade-slippage" value={slippagePct} onChange={(e) => setSlippagePct(e.target.value)} inputMode="decimal" disabled={busy} />
      </div>

      <GasRows />

      <p className="arch-note">
        Trades route through the standard Uniswap v3 pool at its 1% fee tier — Arcanium adds no router fee. Token-side fees are burned; quote-side fees split 10% creator / 90% Arcanium.
      </p>

      {!isConnected ? (
        <ConnectButton />
      ) : (
        <button
          className="arch-primary-button"
          style={{ cursor: busy || parsedAmount === null ? "not-allowed" : "pointer", opacity: busy || parsedAmount === null ? 0.7 : 1 }}
          disabled={busy || parsedAmount === null}
          onClick={() => void submit()}
        >
          {state.step === "approving"
            ? "Approving…"
            : state.step === "swapping"
              ? "Swapping…"
              : side === "buy"
                ? `Buy ${symbol}`
                : `Sell ${symbol}`}
        </button>
      )}

      {state.step === "done" ? (
        <p className="arch-note" style={{ color: "var(--arch-positive)" }}>
          ✓ Swap confirmed.{" "}
          <a href={`${ARC_EXPLORER}/tx/${state.txHash}`} target="_blank" rel="noreferrer" style={{ textDecoration: "underline" }}>
            View transaction
          </a>
        </p>
      ) : null}
      {state.step === "error" ? (
        <p className="arch-note" style={{ color: "var(--arch-negative)" }}>{state.message}</p>
      ) : null}
    </div>
  );
}
