"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useAccount, usePublicClient, useReadContract, useSwitchChain, useWriteContract } from "wagmi";
import { decodeEventLog, parseAbiItem, type Hex } from "viem";
import {
  arcTestnet,
  erc20Abi,
  formatQuoteUnits,
  PAIR_TOKEN_ADDRESS,
  PAIR_TOKEN_SYMBOL,
  parseQuoteUnits,
} from "@/lib/bridgeClient";
import { FACTORY_ADDRESS, factoryAbi } from "@/lib/launchpad";
import { useToast } from "@/components/ui/Toast";
import { ConnectButton } from "@/components/ConnectButton";

const launchedEvent = parseAbiItem(
  "event Launched(address indexed token, address indexed creator, address pairToken, address pool, uint256 positionId, string metadataUri)",
);

type CreateState =
  | { readonly step: "form" }
  | { readonly step: "needs_gas" }
  | { readonly step: "approving" }
  | { readonly step: "launching" }
  | { readonly step: "error"; readonly message: string };

/** Native gas floor for a full launch (token + pool + lock is gas-heavy). */
const LAUNCH_GAS_FLOOR = 40_000_000_000_000_000n; // ~0.04 native USDC

/**
 * Live launch form. A token is created on Arc, paired with the canonical pair
 * token (native Arc USDC), with its Uniswap v3 pool and permanently locked
 * liquidity in one atomic transaction. The creator pays the launch fee and any
 * initial buy in that same token — which on Arc is the chain's native USDC, so
 * a wallet holding Arc USDC can launch directly, no bridge required.
 */
export function CreateForm() {
  const router = useRouter();
  const { address, isConnected, chainId } = useAccount();
  const { switchChainAsync } = useSwitchChain();
  const { writeContractAsync } = useWriteContract();
  const arcPublic = usePublicClient({ chainId: arcTestnet.id });
  const { toast } = useToast();

  const [name, setName] = useState("");
  const [ticker, setTicker] = useState("");
  const [description, setDescription] = useState("");
  const [website, setWebsite] = useState("");
  const [twitter, setTwitter] = useState("");
  const [telegram, setTelegram] = useState("");
  const [imageUrl, setImageUrl] = useState("");
  const [creatorBuy, setCreatorBuy] = useState("");
  const [state, setState] = useState<CreateState>({ step: "form" });

  const launchFee = useReadContract({
    address: FACTORY_ADDRESS,
    abi: factoryAbi,
    functionName: "launchFee",
    chainId: arcTestnet.id,
    query: { enabled: FACTORY_ADDRESS !== undefined, refetchInterval: 60_000 },
  });
  const pairBalance = useReadContract({
    address: PAIR_TOKEN_ADDRESS,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: address === undefined ? undefined : [address],
    chainId: arcTestnet.id,
    query: { enabled: address !== undefined && PAIR_TOKEN_ADDRESS !== undefined, refetchInterval: 15_000 },
  });

  const tickerNormalized = ticker.trim().toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 10);
  const validUrl = (u: string): boolean => u === "" || /^https:\/\/[^\s]+$/.test(u);

  const buyAmount = useMemo<bigint>(() => {
    if (creatorBuy.trim() === "") return 0n;
    try { return parseQuoteUnits(creatorBuy); } catch { return 0n; }
  }, [creatorBuy]);

  const totalNeeded = (launchFee.data ?? 0n) + buyAmount;

  const formError = ((): string | null => {
    if (name.trim().length === 0) return null;
    if (name.trim().length > 48) return "Name too long (max 48)";
    if (tickerNormalized.length < 2) return "Ticker needs 2–10 letters/numbers";
    if (!validUrl(website) || !validUrl(twitter) || !validUrl(telegram) || !validUrl(imageUrl)) {
      return "Links must be https:// URLs";
    }
    return null;
  })();

  const busy = state.step === "approving" || state.step === "launching";

  async function submit(): Promise<void> {
    if (
      address === undefined || arcPublic === undefined ||
      FACTORY_ADDRESS === undefined || PAIR_TOKEN_ADDRESS === undefined ||
      launchFee.data === undefined || formError !== null || name.trim().length === 0
    ) return;
    try {
      if (chainId !== arcTestnet.id) await switchChainAsync({ chainId: arcTestnet.id });

      if (pairBalance.data !== undefined && pairBalance.data < totalNeeded) {
        setState({ step: "error", message: `Need ${formatQuoteUnits(totalNeeded)} ${PAIR_TOKEN_SYMBOL} (fee + buy); you have ${formatQuoteUnits(pairBalance.data)}` });
        return;
      }

      // A full launch is gas-heavy; fail fast with a clear message if the
      // wallet can't cover it rather than a cryptic wallet error.
      const gasBal = await arcPublic.getBalance({ address });
      if (gasBal < LAUNCH_GAS_FLOOR) { setState({ step: "needs_gas" }); return; }

      const metadata = {
        name: name.trim(), symbol: tickerNormalized, description: description.trim(),
        image: imageUrl.trim(), website: website.trim(), twitter: twitter.trim(),
        telegram: telegram.trim(), discord: "", creator: address, createdAt: new Date().toISOString(),
      };
      const metadataUri = `data:application/json;base64,${btoa(JSON.stringify(metadata))}`;

      const allowance = await arcPublic.readContract({
        address: PAIR_TOKEN_ADDRESS, abi: erc20Abi, functionName: "allowance", args: [address, FACTORY_ADDRESS],
      });
      if (allowance < totalNeeded) {
        setState({ step: "approving" });
        const approveTx = await writeContractAsync({
          address: PAIR_TOKEN_ADDRESS, abi: erc20Abi, functionName: "approve", args: [FACTORY_ADDRESS, totalNeeded], chainId: arcTestnet.id,
        });
        await arcPublic.waitForTransactionReceipt({ hash: approveTx });
      }

      setState({ step: "launching" });
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
      const txHash = await writeContractAsync({
        address: FACTORY_ADDRESS, abi: factoryAbi, functionName: "launch",
        args: [{ name: name.trim(), symbol: tickerNormalized, metadataUri, pairToken: PAIR_TOKEN_ADDRESS, creatorBuyAmount: buyAmount, minTokensOut: 0n, deadline }],
        chainId: arcTestnet.id,
      });
      const receipt = await arcPublic.waitForTransactionReceipt({ hash: txHash });
      if (receipt.status !== "success") { setState({ step: "error", message: "Launch transaction reverted" }); return; }
      let newToken: string | null = null;
      for (const log of receipt.logs) {
        try { newToken = decodeEventLog({ abi: [launchedEvent], data: log.data, topics: log.topics }).args.token; break; } catch { /* not it */ }
      }
      toast({ tone: "success", title: "Token launched", description: "Your pool is live with permanently locked liquidity." });
      router.push(newToken !== null ? `/tokens/${newToken}` : "/tokens");
    } catch (err) {
      const message = err instanceof Error ? (err.message.split("\n")[0] ?? "failed") : "failed";
      if (/insufficient funds|gas required|out of gas/i.test(message)) { setState({ step: "needs_gas" }); return; }
      setState({ step: "error", message: message.toLowerCase().includes("rejected") ? "Rejected in wallet" : message });
      toast({ tone: "error", title: message.toLowerCase().includes("rejected") ? "Rejected in wallet" : "Launch failed", description: message.toLowerCase().includes("rejected") ? undefined : message });
    }
  }

  const disabled = busy || formError !== null || name.trim() === "";

  return (
    <div>
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
        <label htmlFor="cf-buy">Initial buy (optional, in {PAIR_TOKEN_SYMBOL})</label>
        <input id="cf-buy" value={creatorBuy} onChange={(e) => setCreatorBuy(e.target.value)} placeholder="0.00" inputMode="decimal" disabled={busy} />
        <span className="arch-note">Executed atomically inside the launch — nobody can trade before you.</span>
      </div>

      <div style={{ padding: "0.5rem 0", fontSize: "0.875rem" }}>
        <div style={{ display: "flex", justifyContent: "space-between", padding: "0.2rem 0" }}>
          <span style={{ color: "var(--arch-text-muted)" }}>Launch cost</span>
          <span>{launchFee.data !== undefined ? `${formatQuoteUnits(totalNeeded)} ${PAIR_TOKEN_SYMBOL}` : "—"}</span>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", padding: "0.2rem 0" }}>
          <span style={{ color: "var(--arch-text-muted)" }}>Your {PAIR_TOKEN_SYMBOL} on Arc</span>
          <span>{pairBalance.data !== undefined ? `${formatQuoteUnits(pairBalance.data)} ${PAIR_TOKEN_SYMBOL}` : "—"}</span>
        </div>
      </div>

      {formError !== null ? <p className="arch-note" style={{ color: "var(--arch-negative)" }}>{formError}</p> : null}

      {state.step === "needs_gas" ? (
        <div className="arch-note" style={{ color: "var(--arch-warning)", margin: "0.25rem 0 0.5rem" }}>
          You need a little Arc gas (native USDC) to launch. Top up your wallet with Arc USDC, then press Launch again.
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
          {state.step === "approving" ? `Approving ${PAIR_TOKEN_SYMBOL}…` : state.step === "launching" ? "Launching…" : "Launch token"}
        </button>
      )}
      {state.step === "error" ? <p className="arch-note" style={{ color: "var(--arch-negative)" }}>{state.message}</p> : null}
    </div>
  );
}
