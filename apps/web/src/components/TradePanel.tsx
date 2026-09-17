"use client";

import { useEffect, useMemo, useState } from "react";
import { useAccount, useBalance, usePublicClient, useReadContract, useSwitchChain, useWriteContract } from "wagmi";
import { formatUnits, parseUnits, type Hex } from "viem";
import { erc20Abi } from "@/lib/bridgeClient";
import { explorerTx, getChain, type ChainKey } from "@/lib/chains";
import { ensureChain } from "@/lib/wagmi";
import {
  buyIsZeroForOne,
  encodeV4Swap,
  permit2Abi,
  PERMIT2,
  poolIdFor,
  poolKeyFor,
  quoteV4,
  readV4Slot0,
  universalRouterAbi,
} from "@/lib/v4";
import { useToast } from "@/components/ui/Toast";
import { ConnectButton } from "@/components/ConnectButton";
import { routerAbi } from "@/lib/launchpad";

interface TradePanelProps {
  readonly token: Hex;
  readonly pairToken: Hex;
  readonly symbol: string;
  /** The chain the token was launched on — trades route to its own router. */
  readonly chainKey?: ChainKey;
  /**
   * Which Uniswap this market trades on.
   *
   * Only the footnote reads it: routing is decided server-side from the same
   * launch record, so this exists to keep the sentence under the button
   * truthful rather than to choose a route.
   */
  readonly protocol?: "v3" | "v4";
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
function GasRows({ chainKey = "arc" }: { readonly chainKey?: ChainKey }) {
  const chain = getChain(chainKey);
  const { address } = useAccount();
  const arcPublic = usePublicClient({ chainId: chain.id });
  const native = useBalance({ address, chainId: chain.id, query: { refetchInterval: 20_000 } });
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
          You have no Arc gas — add a little native USDC to your wallet on Arc, then trade.
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
export function TradePanel({ token, pairToken, symbol, chainKey = "arc", protocol = "v3" }: TradePanelProps) {
  // Trades execute on the chain the token launched on, against that chain's
  // own Uniswap router and quote asset (native USDC on Arc).
  const chain = getChain(chainKey);
  const ROUTER_ADDRESS = chain.uniswap.swapRouter;
  const PAIR_TOKEN_SYMBOL = chain.quote.symbol;
  const formatQuoteUnits = (v: bigint): string => formatUnits(v, chain.quote.decimals);
  const parseQuoteUnits = (v: string): bigint => parseUnits(v, chain.quote.decimals);
  const { address, isConnected, chainId } = useAccount();
  const { switchChainAsync } = useSwitchChain();
  const { writeContractAsync } = useWriteContract();
  const arcPublic = usePublicClient({ chainId: chain.id });
  const { toast } = useToast();

  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [amountText, setAmountText] = useState("");
  const [slippagePct, setSlippagePct] = useState("5");
  const [state, setState] = useState<TradeState>({ step: "idle" });

  /**
   * Which Uniswap this market lives on.
   *
   * Probed rather than assumed. A v4 pool is a key, so its existence is a
   * question you can ask directly — does this id have liquidity — and that
   * answer does not depend on the indexer being current. Null means "not
   * determined yet", and trading stays disabled until it is: sending a v3
   * swap at a v4 market would revert, and sending a v4 swap at a v3 market
   * would address a pool that does not exist.
   */
  const [isV4, setIsV4] = useState<boolean | null>(null);
  const v4cfg = chain.v4;

  useEffect(() => {
    if (arcPublic === undefined) return undefined;
    const hook = v4cfg?.hook;
    if (hook === undefined) { setIsV4(false); return undefined; }
    let cancelled = false;
    void (async () => {
      const key = poolKeyFor(token, pairToken, hook, v4cfg!.poolFee, v4cfg!.tickSpacing);
      const slot = await readV4Slot0(arcPublic, poolIdFor(key));
      if (!cancelled) setIsV4(slot !== null && slot.sqrtPriceX96 > 0n);
    })();
    return () => { cancelled = true; };
  }, [arcPublic, token, pairToken, v4cfg]);

  const quoteBalance = useReadContract({
    address: pairToken,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: address === undefined ? undefined : [address],
    chainId: chain.id,
    query: { enabled: address !== undefined, refetchInterval: 8_000 },
  });
  const tokenBalance = useReadContract({
    address: token,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: address === undefined ? undefined : [address],
    chainId: chain.id,
    query: { enabled: address !== undefined, refetchInterval: 8_000 },
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

  /**
   * A v4 swap.
   *
   * Two approvals the first time, then none. The UniversalRouter pulls the
   * input through Permit2 rather than holding an allowance itself, so the
   * token is approved to Permit2 once (unbounded, to Permit2 only) and Permit2
   * is then told the router may spend it until an expiry. Both are checked
   * before being sent, so a returning trader signs neither.
   */
  async function submitV4(tokenIn: Hex): Promise<void> {
    if (address === undefined || parsedAmount === null || arcPublic === undefined) return;
    const hook = v4cfg?.hook;
    const router = v4cfg?.universalRouter;
    if (hook === undefined || router === undefined) return;

    if (v4cfg === undefined) return;
    const key = poolKeyFor(token, pairToken, hook, v4cfg.poolFee, v4cfg.tickSpacing);
    const zeroForOne = side === "buy" ? buyIsZeroForOne(token, pairToken) : !buyIsZeroForOne(token, pairToken);

    // 1. The token must let Permit2 move it.
    const erc20Allowance = await arcPublic.readContract({
      address: tokenIn, abi: erc20Abi, functionName: "allowance", args: [address, PERMIT2],
    });
    if (erc20Allowance < parsedAmount) {
      setState({ step: "approving" });
      const tx = await writeContractAsync({
        address: tokenIn, abi: erc20Abi, functionName: "approve",
        args: [PERMIT2, 2n ** 256n - 1n], chainId: chain.id,
      });
      await arcPublic.waitForTransactionReceipt({ hash: tx });
    }

    // 2. Permit2 must let the router spend it.
    const [permitAmount, permitExpiry] = await arcPublic.readContract({
      address: PERMIT2, abi: permit2Abi, functionName: "allowance",
      args: [address, tokenIn, router],
    });
    const nowSec = BigInt(Math.floor(Date.now() / 1000));
    if (permitAmount < parsedAmount || BigInt(permitExpiry) <= nowSec) {
      setState({ step: "approving" });
      const tx = await writeContractAsync({
        address: PERMIT2, abi: permit2Abi, functionName: "approve",
        args: [tokenIn, router, 2n ** 160n - 1n, Number(nowSec + 30n * 24n * 60n * 60n)],
        chainId: chain.id,
      });
      await arcPublic.waitForTransactionReceipt({ hash: tx });
    }

    // 3. Quote, bound it, swap. A quote that cannot be obtained stops the
    //    trade rather than defaulting to zero, which would accept any price.
    setState({ step: "swapping" });
    const expectedOut = await quoteV4(arcPublic, key, zeroForOne, parsedAmount);
    if (expectedOut === null || expectedOut === 0n) {
      setState({ step: "error", message: "Could not get a quote for this trade." });
      return;
    }
    const slippageBps = BigInt(Math.round(Number.parseFloat(slippagePct || "5") * 100));
    const minOut = expectedOut - (expectedOut * slippageBps) / 10_000n;

    const { commands, inputs } = encodeV4Swap(key, zeroForOne, parsedAmount, minOut);
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
    const txHash = await writeContractAsync({
      address: router, abi: universalRouterAbi, functionName: "execute",
      args: [commands, [...inputs], deadline], chainId: chain.id,
    });
    const receipt = await arcPublic.waitForTransactionReceipt({ hash: txHash });
    if (receipt.status !== "success") {
      setState({ step: "error", message: "Swap reverted" });
      return;
    }
    setState({ step: "done", txHash });
    setAmountText("");
    void quoteBalance.refetch();
    void tokenBalance.refetch();
  }

  async function submit(): Promise<void> {
    if (address === undefined || parsedAmount === null || ROUTER_ADDRESS === undefined || arcPublic === undefined) return;
    try {
      await ensureChain(chain.key, chainId, switchChainAsync);
      const tokenIn = side === "buy" ? pairToken : token;
      const tokenOut = side === "buy" ? token : pairToken;

      if (isV4 === true && v4cfg?.hook !== undefined && v4cfg.universalRouter !== undefined) {
        await submitV4(tokenIn);
        return;
      }

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
          chainId: chain.id,
        });
        await arcPublic.waitForTransactionReceipt({ hash: approveTx });
      }

      // Slippage: simulate the swap for the expected output, then bound it.
      // SwapRouter02: no deadline field in ExactInputSingleParams.
      setState({ step: "swapping" });
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
          amountIn: parsedAmount,
          amountOutMinimum: minOut,
          sqrtPriceLimitX96: 0n,
        }],
        chainId: chain.id,
      });
      const receipt = await arcPublic.waitForTransactionReceipt({ hash: txHash });
      if (receipt.status !== "success") {
        setState({ step: "error", message: "Swap reverted" });
        return;
      }
      setState({ step: "done", txHash });
      setAmountText("");
      // Refresh both balances immediately so the trade feels instant.
      void quoteBalance.refetch();
      void tokenBalance.refetch();
      toast({ tone: "success", title: side === "buy" ? `Bought ${symbol}` : `Sold ${symbol}`, description: "Swap confirmed on Arc.", href: `${explorerTx(chain, txHash)}`, hrefLabel: "View transaction" });
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
          <span className="arch-asset-chip">{side === "buy" ? PAIR_TOKEN_SYMBOL : symbol}</span>
        </div>
        <div className="arch-amount-row">
          <input className="arch-amount-input" placeholder="0.00" inputMode="decimal" value={amountText} onChange={(e) => setAmountText(e.target.value)} disabled={busy} aria-label="Trade amount" />
        </div>
        <div className="arch-panel-foot">
          <span>Balance: {bal !== undefined ? (side === "buy" ? `${formatQuoteUnits(bal)} ${PAIR_TOKEN_SYMBOL}` : `${formatToken18(bal)} ${symbol}`) : "—"}</span>
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

      <GasRows chainKey={chainKey} />

      <p className="arch-note">
        {protocol === "v4"
          ? "Trades route through this token's Uniswap v4 pool at its 1% fee tier. Arcanium adds no router fee."
          : "Trades route through the standard Uniswap v3 pool at its 1% fee tier. Arcanium adds no router fee."}
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
          <a href={`${explorerTx(chain, state.txHash)}`} target="_blank" rel="noreferrer" style={{ textDecoration: "underline" }}>
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
