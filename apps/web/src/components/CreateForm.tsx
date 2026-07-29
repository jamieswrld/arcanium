"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useAccount, useConnect, usePublicClient, useReadContract, useSwitchChain, useWriteContract } from "wagmi";
import { decodeEventLog, parseAbiItem } from "viem";
import { arcTestnet, AUSD_ADDRESS, erc20Abi, formatQuoteUnits, parseQuoteUnits } from "@/lib/bridgeClient";
import { FACTORY_ADDRESS, factoryAbi } from "@/lib/launchpad";
import { useToast } from "@/components/ui/Toast";

const launchedEvent = parseAbiItem(
  "event Launched(address indexed token, address indexed creator, address pairToken, address pool, uint256 positionId, string metadataUri)",
);

type CreateState =
  | { readonly step: "form" }
  | { readonly step: "approving" }
  | { readonly step: "launching" }
  | { readonly step: "error"; readonly message: string };

/**
 * Live launch form. Metadata is embedded as a content-addressed data URI on
 * testnet (production swaps in S3/IPFS upload); the launch fee is read live
 * from the factory; token creation, pool, permanent lock, and the optional
 * creator buy are one atomic transaction.
 */
export function CreateForm() {
  const router = useRouter();
  const { address, isConnected, chainId } = useAccount();
  const { connectors, connect } = useConnect();
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
  const ausdBalance = useReadContract({
    address: AUSD_ADDRESS,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: address === undefined ? undefined : [address],
    chainId: arcTestnet.id,
    query: { enabled: address !== undefined && AUSD_ADDRESS !== undefined },
  });

  const tickerNormalized = ticker.trim().toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 10);
  const validUrl = (u: string): boolean => u === "" || /^https:\/\/[^\s]+$/.test(u);
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
      FACTORY_ADDRESS === undefined || AUSD_ADDRESS === undefined ||
      launchFee.data === undefined || formError !== null || name.trim().length === 0
    ) return;
    try {
      if (chainId !== arcTestnet.id) await switchChainAsync({ chainId: arcTestnet.id });

      const buyAmount = creatorBuy.trim() === "" ? 0n : parseQuoteUnits(creatorBuy);
      const totalNeeded = launchFee.data + buyAmount;
      if (ausdBalance.data !== undefined && ausdBalance.data < totalNeeded) {
        setState({ step: "error", message: `Need ${formatQuoteUnits(totalNeeded)} aUSD (fee + buy); you have ${formatQuoteUnits(ausdBalance.data)}` });
        return;
      }

      const metadata = {
        name: name.trim(),
        symbol: tickerNormalized,
        description: description.trim(),
        image: imageUrl.trim(),
        website: website.trim(),
        twitter: twitter.trim(),
        telegram: telegram.trim(),
        discord: "",
        creator: address,
        createdAt: new Date().toISOString(),
      };
      const metadataUri = `data:application/json;base64,${btoa(JSON.stringify(metadata))}`;

      const allowance = await arcPublic.readContract({
        address: AUSD_ADDRESS,
        abi: erc20Abi,
        functionName: "allowance",
        args: [address, FACTORY_ADDRESS],
      });
      if (allowance < totalNeeded) {
        setState({ step: "approving" });
        const approveTx = await writeContractAsync({
          address: AUSD_ADDRESS,
          abi: erc20Abi,
          functionName: "approve",
          args: [FACTORY_ADDRESS, totalNeeded],
          chainId: arcTestnet.id,
        });
        await arcPublic.waitForTransactionReceipt({ hash: approveTx });
      }

      setState({ step: "launching" });
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
      const txHash = await writeContractAsync({
        address: FACTORY_ADDRESS,
        abi: factoryAbi,
        functionName: "launch",
        args: [{
          name: name.trim(),
          symbol: tickerNormalized,
          metadataUri,
          pairToken: AUSD_ADDRESS,
          creatorBuyAmount: buyAmount,
          minTokensOut: 0n,
          deadline,
        }],
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
          const decoded = decodeEventLog({ abi: [launchedEvent], data: log.data, topics: log.topics });
          newToken = decoded.args.token;
          break;
        } catch { /* not the Launched log */ }
      }
      toast({ tone: "success", title: "Token launched", description: "Your pool is live with permanently locked liquidity." });
      router.push(newToken !== null ? `/tokens/${newToken}` : "/tokens");
    } catch (err) {
      const message = err instanceof Error ? (err.message.split("\n")[0] ?? "failed") : "failed";
      setState({
        step: "error",
        message: message.toLowerCase().includes("rejected") ? "Rejected in wallet" : message,
      });
      toast({ tone: "error", title: message.toLowerCase().includes("rejected") ? "Rejected in wallet" : "Launch failed", description: message.toLowerCase().includes("rejected") ? undefined : message });
    }
  }

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
        <label htmlFor="cf-desc">Description (optional)</label>
        <textarea id="cf-desc" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} disabled={busy} maxLength={500} />
      </div>
      <div className="arch-form-row">
        <label htmlFor="cf-image">Image URL (optional, https)</label>
        <input id="cf-image" value={imageUrl} onChange={(e) => setImageUrl(e.target.value)} placeholder="https://…" disabled={busy} />
      </div>
      <details>
        <summary className="arch-note" style={{ cursor: "pointer", marginBottom: "0.5rem" }}>
          Social links (optional)
        </summary>
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
        <label htmlFor="cf-buy">Initial creator purchase in aUSD (optional)</label>
        <input id="cf-buy" value={creatorBuy} onChange={(e) => setCreatorBuy(e.target.value)} placeholder="0.00" inputMode="decimal" disabled={busy} />
        <span className="arch-note">
          Executed atomically inside the launch transaction — nobody can trade
          before you.
        </span>
      </div>

      <div style={{ padding: "0.5rem 0", fontSize: "0.875rem" }}>
        <div style={{ display: "flex", justifyContent: "space-between", padding: "0.2rem 0" }}>
          <span style={{ color: "var(--arch-text-muted)" }}>Launch fee (live from contract)</span>
          <span>{launchFee.data !== undefined ? `${formatQuoteUnits(launchFee.data)} aUSD` : "—"}</span>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", padding: "0.2rem 0" }}>
          <span style={{ color: "var(--arch-text-muted)" }}>Your aUSD balance</span>
          <span>{ausdBalance.data !== undefined ? `${formatQuoteUnits(ausdBalance.data)} aUSD` : "—"}</span>
        </div>
      </div>

      {formError !== null ? (
        <p className="arch-note" style={{ color: "var(--arch-negative)" }}>{formError}</p>
      ) : null}

      {!isConnected ? (
        <button
          className="arch-primary-button"
          style={{ cursor: "pointer", opacity: 1 }}
          onClick={() => { const c = connectors[0]; if (c !== undefined) connect({ connector: c }); }}
        >
          Connect wallet
        </button>
      ) : (
        <button
          className="arch-primary-button"
          style={{ cursor: busy || formError !== null || name.trim() === "" ? "not-allowed" : "pointer", opacity: busy || formError !== null || name.trim() === "" ? 0.7 : 1 }}
          disabled={busy || formError !== null || name.trim() === ""}
          onClick={() => void submit()}
        >
          {state.step === "approving" ? "Approving aUSD…" : state.step === "launching" ? "Launching…" : "Launch token"}
        </button>
      )}
      {state.step === "error" ? (
        <p className="arch-note" style={{ color: "var(--arch-negative)" }}>{state.message}</p>
      ) : null}
    </div>
  );
}
