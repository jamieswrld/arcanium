"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useAccount, usePublicClient, useReadContract, useSwitchChain, useWriteContract } from "wagmi";
import { decodeEventLog, parseAbiItem, type Hex } from "viem";
import {
  applyBps,
  arcTestnet,
  AUSD_ADDRESS,
  baseChain,
  BRIDGE_ADDRESS,
  bridgeActionId,
  erc20Abi,
  formatQuoteUnits,
  parseQuoteUnits,
  USDC_ADDRESS,
  VAULT_ADDRESS,
  vaultAbi,
} from "@/lib/bridgeClient";
import { FACTORY_ADDRESS, factoryAbi } from "@/lib/launchpad";
import { useToast } from "@/components/ui/Toast";
import { ConnectButton } from "@/components/ConnectButton";

const launchedEvent = parseAbiItem(
  "event Launched(address indexed token, address indexed creator, address pairToken, address pool, uint256 positionId, string metadataUri)",
);

type FundingSource = "aUSD" | "USDC";

type CreateState =
  | { readonly step: "form" }
  | { readonly step: "bridging_approve" }
  | { readonly step: "bridging_deposit" }
  | { readonly step: "bridging_wait" }
  | { readonly step: "needs_gas" }
  | { readonly step: "approving" }
  | { readonly step: "launching" }
  | { readonly step: "error"; readonly message: string };

/** Round native (18d) gas floor for a full launch (token + pool + lock). A
 *  first-block launch is gas-heavy, so we warn below this before asking the
 *  wallet to sign a tx that would otherwise fail with "insufficient funds". */
const LAUNCH_GAS_FLOOR = 40_000_000_000_000_000n; // ~0.04 native USDC

/**
 * Live launch form. A token is created on Arc, paired with aUSD, with its
 * Uniswap v3 pool and permanently locked liquidity in one atomic transaction.
 * Funding: pay the launch cost with aUSD you already hold on Arc, or with
 * USDC on Base — in which case we bridge exactly the shortfall to aUSD first,
 * then launch.
 */
export function CreateForm() {
  const router = useRouter();
  const { address, isConnected, chainId } = useAccount();
  const { switchChainAsync } = useSwitchChain();
  const { writeContractAsync } = useWriteContract();
  const arcPublic = usePublicClient({ chainId: arcTestnet.id });
  const basePublic = usePublicClient({ chainId: baseChain.id });
  const { toast } = useToast();

  const [name, setName] = useState("");
  const [ticker, setTicker] = useState("");
  const [description, setDescription] = useState("");
  const [website, setWebsite] = useState("");
  const [twitter, setTwitter] = useState("");
  const [telegram, setTelegram] = useState("");
  const [imageUrl, setImageUrl] = useState("");
  const [creatorBuy, setCreatorBuy] = useState("");
  const [funding, setFunding] = useState<FundingSource>("aUSD");
  const [state, setState] = useState<CreateState>({ step: "form" });

  const launchFee = useReadContract({
    address: FACTORY_ADDRESS,
    abi: factoryAbi,
    functionName: "launchFee",
    chainId: arcTestnet.id,
    query: { enabled: FACTORY_ADDRESS !== undefined, refetchInterval: 60_000 },
  });
  const feeBps = useReadContract({
    address: VAULT_ADDRESS,
    abi: vaultAbi,
    functionName: "feeBps",
    chainId: baseChain.id,
    query: { enabled: VAULT_ADDRESS !== undefined, refetchInterval: 60_000 },
  });
  const ausdBalance = useReadContract({
    address: AUSD_ADDRESS,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: address === undefined ? undefined : [address],
    chainId: arcTestnet.id,
    query: { enabled: address !== undefined && AUSD_ADDRESS !== undefined, refetchInterval: 15_000 },
  });
  const usdcBalance = useReadContract({
    address: USDC_ADDRESS,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: address === undefined ? undefined : [address],
    chainId: baseChain.id,
    query: { enabled: address !== undefined, refetchInterval: 15_000 },
  });

  const tickerNormalized = ticker.trim().toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 10);
  const validUrl = (u: string): boolean => u === "" || /^https:\/\/[^\s]+$/.test(u);

  const buyAmount = useMemo<bigint>(() => {
    if (creatorBuy.trim() === "") return 0n;
    try {
      return parseQuoteUnits(creatorBuy);
    } catch {
      return 0n;
    }
  }, [creatorBuy]);

  const totalNeeded = (launchFee.data ?? 0n) + buyAmount; // aUSD units (6d)

  // For the USDC path: USDC to deposit so the net (post-bridge-fee) aUSD covers
  // the shortfall, grossed up for the fee with a 1-unit safety margin.
  const shortfallAusd = useMemo<bigint>(() => {
    const bal = ausdBalance.data ?? 0n;
    return totalNeeded > bal ? totalNeeded - bal : 0n;
  }, [ausdBalance.data, totalNeeded]);

  const usdcToDeposit = useMemo<bigint>(() => {
    if (shortfallAusd === 0n) return 0n;
    const bps = feeBps.data ?? 0n;
    const denom = 10_000n - bps;
    if (denom <= 0n) return shortfallAusd;
    return (shortfallAusd * 10_000n + denom - 1n) / denom + 1n;
  }, [shortfallAusd, feeBps.data]);

  const formError = ((): string | null => {
    if (name.trim().length === 0) return null;
    if (name.trim().length > 48) return "Name too long (max 48)";
    if (tickerNormalized.length < 2) return "Ticker needs 2–10 letters/numbers";
    if (!validUrl(website) || !validUrl(twitter) || !validUrl(telegram) || !validUrl(imageUrl)) {
      return "Links must be https:// URLs";
    }
    return null;
  })();

  const busy =
    state.step === "bridging_approve" || state.step === "bridging_deposit" ||
    state.step === "bridging_wait" || state.step === "approving" || state.step === "launching";

  async function ensureArcGas(): Promise<boolean> {
    if (arcPublic === undefined || address === undefined) return true;
    const bal = await arcPublic.getBalance({ address });
    if (bal < LAUNCH_GAS_FLOOR) {
      setState({ step: "needs_gas" });
      return false;
    }
    return true;
  }

  /** Bridge the USDC shortfall to aUSD, then wait for the mint to land. */
  async function bridgeShortfall(): Promise<boolean> {
    if (address === undefined || basePublic === undefined || arcPublic === undefined) return false;
    if (VAULT_ADDRESS === undefined || BRIDGE_ADDRESS === undefined) return false;
    const vault = VAULT_ADDRESS;
    const bridge = BRIDGE_ADDRESS;
    if (usdcBalance.data !== undefined && usdcBalance.data < usdcToDeposit) {
      setState({ step: "error", message: `Need ${formatQuoteUnits(usdcToDeposit)} USDC on Base; you have ${formatQuoteUnits(usdcBalance.data)}` });
      return false;
    }
    if (chainId !== baseChain.id) await switchChainAsync({ chainId: baseChain.id });

    const allowance = await basePublic.readContract({
      address: USDC_ADDRESS, abi: erc20Abi, functionName: "allowance", args: [address, vault],
    });
    if (allowance < usdcToDeposit) {
      setState({ step: "bridging_approve" });
      const approveTx = await writeContractAsync({
        address: USDC_ADDRESS, abi: erc20Abi, functionName: "approve", args: [vault, usdcToDeposit], chainId: baseChain.id,
      });
      await basePublic.waitForTransactionReceipt({ hash: approveTx });
    }

    setState({ step: "bridging_deposit" });
    const depositTx = await writeContractAsync({
      address: vault, abi: vaultAbi, functionName: "deposit", args: [usdcToDeposit, address], chainId: baseChain.id,
    });
    const receipt = await basePublic.waitForTransactionReceipt({ hash: depositTx });
    const depositLog = receipt.logs.find((l) => l.address.toLowerCase() === vault.toLowerCase());
    if (receipt.status !== "success" || depositLog === undefined) {
      setState({ step: "error", message: "Bridge deposit failed on Base" });
      return false;
    }
    const actionId = bridgeActionId(depositTx, BigInt(depositLog.logIndex));

    // Wait until the destination mint is verified on Arc (≈1 minute).
    setState({ step: "bridging_wait" });
    const deadline = Date.now() + 4 * 60_000;
    for (;;) {
      const processed = await arcPublic.readContract({
        address: bridge, abi: vaultReadAbi, functionName: "processedDeposits", args: [actionId],
      }).catch(() => false);
      if (processed) break;
      if (Date.now() > deadline) {
        setState({ step: "error", message: "Bridge is taking longer than usual — your aUSD will arrive shortly. Reload and launch once it lands." });
        return false;
      }
      await new Promise((r) => setTimeout(r, 5_000));
    }
    await ausdBalance.refetch();
    return true;
  }

  /** The Arc-side launch: approve aUSD to the factory, then launch atomically. */
  async function doLaunch(): Promise<void> {
    if (address === undefined || arcPublic === undefined || FACTORY_ADDRESS === undefined || AUSD_ADDRESS === undefined) return;
    if (chainId !== arcTestnet.id) await switchChainAsync({ chainId: arcTestnet.id });
    if (!(await ensureArcGas())) return;

    const metadata = {
      name: name.trim(), symbol: tickerNormalized, description: description.trim(),
      image: imageUrl.trim(), website: website.trim(), twitter: twitter.trim(),
      telegram: telegram.trim(), discord: "", creator: address, createdAt: new Date().toISOString(),
    };
    const metadataUri = `data:application/json;base64,${btoa(JSON.stringify(metadata))}`;

    const allowance = await arcPublic.readContract({
      address: AUSD_ADDRESS, abi: erc20Abi, functionName: "allowance", args: [address, FACTORY_ADDRESS],
    });
    if (allowance < totalNeeded) {
      setState({ step: "approving" });
      const approveTx = await writeContractAsync({
        address: AUSD_ADDRESS, abi: erc20Abi, functionName: "approve", args: [FACTORY_ADDRESS, totalNeeded], chainId: arcTestnet.id,
      });
      await arcPublic.waitForTransactionReceipt({ hash: approveTx });
    }

    setState({ step: "launching" });
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
    const txHash = await writeContractAsync({
      address: FACTORY_ADDRESS, abi: factoryAbi, functionName: "launch",
      args: [{ name: name.trim(), symbol: tickerNormalized, metadataUri, pairToken: AUSD_ADDRESS, creatorBuyAmount: buyAmount, minTokensOut: 0n, deadline }],
      chainId: arcTestnet.id,
    });
    const receipt = await arcPublic.waitForTransactionReceipt({ hash: txHash });
    if (receipt.status !== "success") {
      setState({ step: "error", message: "Launch transaction reverted" });
      return;
    }
    let newToken: string | null = null;
    for (const log of receipt.logs) {
      try {
        newToken = decodeEventLog({ abi: [launchedEvent], data: log.data, topics: log.topics }).args.token;
        break;
      } catch { /* not the Launched log */ }
    }
    toast({ tone: "success", title: "Token launched", description: "Your pool is live with permanently locked liquidity." });
    router.push(newToken !== null ? `/tokens/${newToken}` : "/tokens");
  }

  async function submit(): Promise<void> {
    if (address === undefined || FACTORY_ADDRESS === undefined || AUSD_ADDRESS === undefined ||
        launchFee.data === undefined || formError !== null || name.trim().length === 0) return;
    try {
      if (funding === "USDC" && shortfallAusd > 0n) {
        toast({ tone: "pending", title: "Bridging USDC → aUSD", description: "Confirm the deposit on Base; we'll continue to launch automatically." });
        if (!(await bridgeShortfall())) return;
      }
      await doLaunch();
    } catch (err) {
      const message = err instanceof Error ? (err.message.split("\n")[0] ?? "failed") : "failed";
      const gasIssue = /insufficient funds|gas required|out of gas/i.test(message);
      if (gasIssue) { setState({ step: "needs_gas" }); return; }
      setState({ step: "error", message: message.toLowerCase().includes("rejected") ? "Rejected in wallet" : message });
      toast({ tone: "error", title: message.toLowerCase().includes("rejected") ? "Rejected in wallet" : "Launch failed", description: message.toLowerCase().includes("rejected") ? undefined : message });
    }
  }

  const disabled = busy || formError !== null || name.trim() === "";
  const primaryLabel = ((): string => {
    switch (state.step) {
      case "bridging_approve": return "Approving USDC…";
      case "bridging_deposit": return "Depositing on Base…";
      case "bridging_wait": return "Bridging to Arc…";
      case "approving": return "Approving aUSD…";
      case "launching": return "Launching…";
      default: return funding === "USDC" && shortfallAusd > 0n ? "Bridge & launch" : "Launch token";
    }
  })();

  return (
    <div>
      {/* identity */}
      <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: "0.75rem" }}>
        <div className="arch-form-row">
          <label htmlFor="cf-name">Token name *</label>
          <input id="cf-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Archway" disabled={busy} maxLength={48} />
        </div>
        <div className="arch-form-row">
          <label htmlFor="cf-ticker">Ticker *</label>
          <input id="cf-ticker" value={ticker} onChange={(e) => setTicker(e.target.value)} placeholder="ARCH" disabled={busy} maxLength={10} />
        </div>
      </div>

      <div className="arch-form-row">
        <label htmlFor="cf-image">Logo image URL (optional, https)</label>
        <div style={{ display: "flex", gap: "0.6rem", alignItems: "center" }}>
          <div aria-hidden style={{ width: 44, height: 44, borderRadius: 12, flexShrink: 0, background: imageUrl.trim() === "" ? "var(--brand-gradient)" : `center/cover no-repeat url(${JSON.stringify(imageUrl.trim())})`, display: "grid", placeItems: "center", color: "#fff", fontWeight: 700 }}>
            {imageUrl.trim() === "" ? (tickerNormalized.slice(0, 2) || "AR") : ""}
          </div>
          <input id="cf-image" style={{ flex: 1 }} value={imageUrl} onChange={(e) => setImageUrl(e.target.value)} placeholder="https://…" disabled={busy} />
        </div>
      </div>

      <div className="arch-form-row">
        <label htmlFor="cf-desc">Description (optional)</label>
        <textarea id="cf-desc" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} disabled={busy} maxLength={500} />
      </div>

      <details>
        <summary className="arch-note" style={{ cursor: "pointer", marginBottom: "0.5rem" }}>Social links (optional)</summary>
        <div className="arch-form-row">
          <label htmlFor="cf-web">Website</label>
          <input id="cf-web" value={website} onChange={(e) => setWebsite(e.target.value)} placeholder="https://…" disabled={busy} />
        </div>
        <div className="arch-form-row">
          <label htmlFor="cf-x">X profile</label>
          <input id="cf-x" value={twitter} onChange={(e) => setTwitter(e.target.value)} placeholder="https://x.com/…" disabled={busy} />
        </div>
        <div className="arch-form-row">
          <label htmlFor="cf-tg">Telegram</label>
          <input id="cf-tg" value={telegram} onChange={(e) => setTelegram(e.target.value)} placeholder="https://t.me/…" disabled={busy} />
        </div>
      </details>

      <div className="arch-form-row">
        <label htmlFor="cf-buy">Initial buy (optional, in aUSD)</label>
        <input id="cf-buy" value={creatorBuy} onChange={(e) => setCreatorBuy(e.target.value)} placeholder="0.00" inputMode="decimal" disabled={busy} />
        <span className="arch-note">Executed atomically inside the launch — nobody can trade before you.</span>
      </div>

      {/* funding source */}
      <div className="arch-form-row">
        <label>Pay with</label>
        <div className="arch-pills" style={{ display: "inline-flex" }}>
          <button type="button" className={funding === "aUSD" ? "arch-pill arch-pill-active" : "arch-pill"} disabled={busy} onClick={() => { setFunding("aUSD"); setState({ step: "form" }); }}>aUSD on Arc</button>
          <button type="button" className={funding === "USDC" ? "arch-pill arch-pill-active" : "arch-pill"} disabled={busy} onClick={() => { setFunding("USDC"); setState({ step: "form" }); }}>USDC on Base</button>
        </div>
      </div>

      {/* cost summary */}
      <div style={{ padding: "0.5rem 0", fontSize: "0.875rem" }}>
        <div style={{ display: "flex", justifyContent: "space-between", padding: "0.2rem 0" }}>
          <span style={{ color: "var(--arch-text-muted)" }}>Launch cost</span>
          <span>{launchFee.data !== undefined ? `${formatQuoteUnits(totalNeeded)} aUSD` : "—"}</span>
        </div>
        {funding === "USDC" ? (
          <>
            <div style={{ display: "flex", justifyContent: "space-between", padding: "0.2rem 0" }}>
              <span style={{ color: "var(--arch-text-muted)" }}>USDC to bridge (incl. fee)</span>
              <span>{shortfallAusd === 0n ? "0 — you already hold enough aUSD" : `${formatQuoteUnits(usdcToDeposit)} USDC`}</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", padding: "0.2rem 0" }}>
              <span style={{ color: "var(--arch-text-muted)" }}>Your USDC on Base</span>
              <span>{usdcBalance.data !== undefined ? `${formatQuoteUnits(usdcBalance.data)} USDC` : "—"}</span>
            </div>
          </>
        ) : (
          <div style={{ display: "flex", justifyContent: "space-between", padding: "0.2rem 0" }}>
            <span style={{ color: "var(--arch-text-muted)" }}>Your aUSD on Arc</span>
            <span>{ausdBalance.data !== undefined ? `${formatQuoteUnits(ausdBalance.data)} aUSD` : "—"}</span>
          </div>
        )}
      </div>

      {formError !== null ? <p className="arch-note" style={{ color: "var(--arch-negative)" }}>{formError}</p> : null}

      {state.step === "needs_gas" ? (
        <div className="arch-note" style={{ color: "var(--arch-warning)", margin: "0.25rem 0 0.5rem" }}>
          You need a little Arc gas to launch. <a href="/gas" style={{ textDecoration: "underline" }}>Top up on the Gas page</a> (gas-free signature), then press Launch again.
        </div>
      ) : null}

      {!isConnected ? (
        <ConnectButton />
      ) : (
        <button
          className="arch-primary-button"
          style={{ cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.7 : 1 }}
          disabled={disabled}
          onClick={() => void submit()}
        >
          {primaryLabel}
        </button>
      )}

      {state.step === "bridging_wait" ? (
        <p className="arch-note" style={{ marginTop: "0.5rem" }}>Waiting for the bridge to mint aUSD on Arc — this completes only when Arc confirms it (≈1 minute), then we launch automatically.</p>
      ) : null}
      {state.step === "error" ? <p className="arch-note" style={{ color: "var(--arch-negative)" }}>{state.message}</p> : null}
    </div>
  );
}

// processedDeposits lives on the bridge contract; reuse a minimal ABI here.
const vaultReadAbi = [
  { type: "function", name: "processedDeposits", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "bool" }] },
] as const;
