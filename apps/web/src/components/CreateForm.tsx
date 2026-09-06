"use client";

import { useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useAccount, usePublicClient, useReadContract, useSwitchChain, useWriteContract } from "wagmi";
import { decodeEventLog, parseAbiItem, type Hex } from "viem";
import { formatUnits, parseUnits } from "viem";
import { erc20Abi } from "@/lib/bridgeClient";
import { factoryAbi, LAUNCH_MODES } from "@/lib/launchpad";
import { liveChains, resolveChain } from "@/lib/chains";
import { ChainMark } from "@/components/ChainMark";
import { ArcaneWandIcon, DiviumBillsIcon } from "@/components/ModeIcons";
import { ensureChain } from "@/lib/wagmi";
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

/** Downscale + compress a picked image to a small data URI so it embeds in the
 *  launch cheaply. WebP when supported (keeps transparency, tiny), else PNG. */
async function compressImage(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const max = 192;
  const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (ctx === null) throw new Error("canvas unavailable");
  ctx.drawImage(bitmap, 0, 0, w, h);
  const webp = canvas.toDataURL("image/webp", 0.8);
  return webp.startsWith("data:image/webp") ? webp : canvas.toDataURL("image/png");
}

/**
 * Live launch form. A token is created on the selected chain, paired with that
 * chain's quote asset (native USDC), with its Uniswap v3 pool and locked
 * liquidity in one atomic transaction. Launching is free (network gas only);
 * any optional initial buy is paid in the pair token — which on Arc is the
 */
export function CreateForm() {
  const router = useRouter();
  const params = useSearchParams();
  const { address, isConnected, chainId } = useAccount();
  const { switchChainAsync } = useSwitchChain();
  const { writeContractAsync } = useWriteContract();
  const { toast } = useToast();

  const available = liveChains();
  const chain = resolveChain(params.get("chain"));
  const factory = chain.factories[0];
  const quote = chain.quote.address;
  const quoteSymbol = chain.quote.symbol;
  const quoteDecimals = chain.quote.decimals;
  const chainPublic = usePublicClient({ chainId: chain.id });

  const fmtQuote = (v: bigint): string => formatUnits(v, quoteDecimals);
  const parseQuote = (v: string): bigint => parseUnits(v, quoteDecimals);

  const [name, setName] = useState("");
  const [ticker, setTicker] = useState("");
  const [description, setDescription] = useState("");
  const [website, setWebsite] = useState("");
  const [twitter, setTwitter] = useState("");
  const [telegram, setTelegram] = useState("");
  const [imageUrl, setImageUrl] = useState(""); // holds a compressed data URI once a file is picked
  const [imgError, setImgError] = useState<string | null>(null);
  const [creatorBuy, setCreatorBuy] = useState("");
  const [feeWallet, setFeeWallet] = useState("");
  const [mode, setMode] = useState<0 | 1 | 2>(0);
  const [state, setState] = useState<CreateState>({ step: "form" });
  const fileRef = useRef<HTMLInputElement>(null);

  async function onPickImage(file: File | undefined): Promise<void> {
    if (file === undefined) return;
    if (!file.type.startsWith("image/")) { setImgError("Please choose an image file."); return; }
    try {
      const dataUri = await compressImage(file);
      if (dataUri.length > 48_000) { setImgError("That image is too detailed — try a simpler logo."); return; }
      setImgError(null);
      setImageUrl(dataUri);
    } catch {
      setImgError("Couldn't read that image. Try a PNG or JPG.");
    }
  }

  const launchFee = useReadContract({
    address: factory,
    abi: factoryAbi,
    functionName: "launchFee",
    chainId: chain.id,
    query: { enabled: factory !== undefined, refetchInterval: 60_000 },
  });
  const pairBalance = useReadContract({
    address: quote,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: address === undefined ? undefined : [address],
    chainId: chain.id,
    query: { enabled: address !== undefined, refetchInterval: 15_000 },
  });

  const tickerNormalized = ticker.trim().toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 10);
  const validUrl = (u: string): boolean => u === "" || /^https:\/\/[^\s]+$/.test(u);

  const buyAmount = useMemo<bigint>(() => {
    if (creatorBuy.trim() === "") return 0n;
    try { return parseQuote(creatorBuy); } catch { return 0n; }
  }, [creatorBuy, quoteDecimals]);

  const totalNeeded = (launchFee.data ?? 0n) + buyAmount;

  const feeWalletTrimmed = feeWallet.trim();
  const feeWalletValid = feeWalletTrimmed === "" || /^0x[0-9a-fA-F]{40}$/.test(feeWalletTrimmed);

  const formError = ((): string | null => {
    if (name.trim().length === 0) return null;
    if (name.trim().length > 48) return "Name too long (max 48)";
    if (tickerNormalized.length < 2) return "Ticker needs 2–10 letters/numbers";
    if (!validUrl(website) || !validUrl(twitter) || !validUrl(telegram)) {
      return "Links must be https:// URLs";
    }
    if (!feeWalletValid) return "Fee recipient must be a valid 0x address";
    return null;
  })();

  const busy = state.step === "approving" || state.step === "launching";

  async function submit(): Promise<void> {
    // Validate with explicit feedback — never fail silently.
    if (factory === undefined || chainPublic === undefined) {
      setState({ step: "error", message: `The launchpad is not deployed on ${chain.name} yet.` });
      return;
    }
    if (name.trim().length === 0) { setState({ step: "error", message: "Enter a token name." }); return; }
    if (tickerNormalized.length < 2) { setState({ step: "error", message: "Enter a ticker (2–10 letters/numbers)." }); return; }
    if (formError !== null) { setState({ step: "error", message: formError }); return; }
    if (address === undefined) { setState({ step: "error", message: "Connect your wallet first." }); return; }
    try {
      await ensureChain(chain.key, chainId, switchChainAsync);

      // Read the launch fee on-demand so a slow/failed hook read never blocks
      // the launch (it's usually 0 anyway).
      const fee = launchFee.data ?? await chainPublic.readContract({
        address: factory, abi: factoryAbi, functionName: "launchFee",
      }).catch(() => 0n);
      const needed = fee + buyAmount;

      const bal = pairBalance.data ?? await chainPublic.readContract({
        address: quote, abi: erc20Abi, functionName: "balanceOf", args: [address],
      }).catch(() => undefined);
      if (bal !== undefined && bal < needed) {
        setState({ step: "error", message: `Need ${fmtQuote(needed)} ${quoteSymbol} (fee + buy); you have ${fmtQuote(bal)}` });
        return;
      }

      // A full launch is gas-heavy; fail fast with a clear message if the
      // wallet can't cover it rather than a cryptic wallet error.
      const gasBal = await chainPublic.getBalance({ address }).catch(() => chain.launchGasFloor);
      if (gasBal < chain.launchGasFloor) { setState({ step: "needs_gas" }); return; }

      const metadata = {
        name: name.trim(), symbol: tickerNormalized, description: description.trim(),
        image: imageUrl.trim(), website: website.trim(), twitter: twitter.trim(),
        telegram: telegram.trim(), discord: "", creator: address, createdAt: new Date().toISOString(),
      };
      const metadataUri = `data:application/json;base64,${btoa(JSON.stringify(metadata))}`;

      const allowance = await chainPublic.readContract({
        address: quote, abi: erc20Abi, functionName: "allowance", args: [address, factory],
      });
      if (needed > 0n && allowance < needed) {
        setState({ step: "approving" });
        const approveTx = await writeContractAsync({
          address: quote, abi: erc20Abi, functionName: "approve", args: [factory, needed], chainId: chain.id,
        });
        await chainPublic.waitForTransactionReceipt({ hash: approveTx });
      }

      setState({ step: "launching" });
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
      const txHash = await writeContractAsync({
        address: factory, abi: factoryAbi, functionName: "launch",
        args: [{
          name: name.trim(), symbol: tickerNormalized, metadataUri, pairToken: quote,
          creatorBuyAmount: buyAmount, minTokensOut: 0n, deadline,
          feeRecipient: (feeWalletValid && feeWalletTrimmed !== "" ? feeWalletTrimmed : "0x0000000000000000000000000000000000000000") as Hex,
          taxBps: 0n,
          mode,
        }],
        chainId: chain.id,
      });
      const receipt = await chainPublic.waitForTransactionReceipt({ hash: txHash });
      if (receipt.status !== "success") { setState({ step: "error", message: "Launch transaction reverted" }); return; }
      let newToken: string | null = null;
      for (const log of receipt.logs) {
        try { newToken = decodeEventLog({ abi: [launchedEvent], data: log.data, topics: log.topics }).args.token; break; } catch { /* not it */ }
      }
      // Persist the metadata (logo) so it displays immediately on the token
      // pages, without waiting for the indexer to catch up. Fire-and-forget.
      if (newToken !== null) {
        void fetch(`/api/tokens/${newToken}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ metadataUri }),
        }).catch(() => undefined);
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

  const disabled = busy; // validation happens on click with a clear message

  return (
    <div>
      <div className="arch-form-row" style={{ marginBottom: "0.9rem" }}>
        <label>Launch on</label>
        <div className="arch-chain-choices">
          {available.map((c) => {
            const on = c.key === chain.key;
            return (
              <button
                key={c.key}
                type="button"
                disabled={busy}
                aria-pressed={on}
                onClick={() => router.replace(`/create?chain=${c.key}`, { scroll: false })}
                className={on ? "arch-chain-choice arch-chain-choice-active" : "arch-chain-choice"}
                style={{ ["--chain-accent" as string]: c.accent }}
              >
                <ChainMark chain={c} size={19} />
                <span>
                  <span style={{ display: "block", fontWeight: 700 }}>{c.shortName}</span>
                  <span className="arch-note" style={{ fontSize: "0.68rem" }}>Pairs with {c.quote.symbol}</span>
                </span>
              </button>
            );
          })}
        </div>
        <p className="arch-note" style={{ margin: "0.4rem 0 0", fontSize: "0.75rem" }}>
          Your token launches on {chain.name} and pairs with {chain.quote.symbol}. You pay{" "}
          {chain.nativeCurrency.symbol} for gas — nothing else.
        </p>
      </div>

      <div className="arch-form-grid">
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
        <label>Logo image (optional)</label>
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp"
          style={{ display: "none" }}
          onChange={(e) => void onPickImage(e.target.files?.[0])}
          disabled={busy}
        />
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={busy}
          style={{ display: "flex", gap: "0.75rem", alignItems: "center", width: "100%", textAlign: "left", cursor: busy ? "not-allowed" : "pointer", background: "var(--muted)", border: "1px dashed var(--border)", borderRadius: 12, padding: "0.7rem 0.8rem" }}
        >
          <span aria-hidden style={{ width: 52, height: 52, borderRadius: 12, flexShrink: 0, background: imageUrl === "" ? "var(--card)" : `center/cover no-repeat url(${JSON.stringify(imageUrl)})`, border: imageUrl === "" ? "1px solid var(--border)" : "none" }} />
          <span style={{ minWidth: 0 }}>
            <span style={{ display: "block", fontWeight: 600, fontSize: "0.9rem" }}>{imageUrl === "" ? "Click to upload a logo" : "Change logo"}</span>
            <span className="arch-note">PNG, JPG, GIF or WebP — we resize it for you.</span>
          </span>
        </button>
        {imgError !== null ? <span className="arch-note" style={{ color: "var(--arch-negative)" }}>{imgError}</span> : null}
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
        <label htmlFor="cf-buy">Initial buy (optional, in {quoteSymbol})</label>
        <input id="cf-buy" value={creatorBuy} onChange={(e) => setCreatorBuy(e.target.value)} placeholder="0.00" inputMode="decimal" disabled={busy} />
        <span className="arch-note">Executed atomically inside the launch — nobody can trade before you.</span>
      </div>

      <div className="arch-form-row">
        <label>Creator fee mode</label>
        <div style={{ display: "grid", gap: "0.5rem" }}>
          {LAUNCH_MODES.map((m) => {
            const active = mode === m.id;
            return (
              <button
                key={m.key}
                type="button"
                disabled={busy}
                onClick={() => setMode(m.id as 0 | 1 | 2)}
                style={{
                  display: "flex", gap: "0.7rem", alignItems: "flex-start", textAlign: "left", cursor: busy ? "not-allowed" : "pointer",
                  border: `1px solid ${active ? "color-mix(in oklch, var(--primary) 65%, var(--border))" : "var(--border)"}`,
                  background: active ? "color-mix(in oklch, var(--primary) 12%, var(--card))" : "color-mix(in oklch, var(--background) 45%, var(--card))",
                  borderRadius: 12, padding: "0.7rem 0.8rem", color: "inherit",
                  boxShadow: active ? "0 0 20px oklch(0.58 0.24 295 / 0.16)" : "none",
                }}
              >
                <span aria-hidden style={{ marginTop: 1, width: 26, display: "grid", placeItems: "center" }}>
                  {m.id === 1 ? <DiviumBillsIcon size={24} /> : m.id === 2 ? <ArcaneWandIcon size={24} /> : <span style={{ fontSize: 18 }}>💼</span>}
                </span>
                <span style={{ minWidth: 0 }}>
                  <span style={{ display: "block", fontWeight: 700, fontSize: "0.92rem" }}>
                    {m.label}{m.id === 0 ? " · default" : ""}
                  </span>
                  <span className="arch-note" style={{ display: "block" }}>{m.blurb}</span>
                </span>
              </button>
            );
          })}
        </div>
        <span className="arch-note" style={{ marginTop: "0.35rem" }}>
          Fixed at launch and can never be changed. Traders always pay the same 1% pool fee.
        </span>
      </div>

      <div className="arch-form-row">
        <label htmlFor="cf-feewallet">Creator fee wallet (optional)</label>
        <input id="cf-feewallet" value={feeWallet} onChange={(e) => setFeeWallet(e.target.value)} placeholder="0x… (defaults to your wallet)" spellCheck={false} disabled={busy} style={{ fontFamily: "monospace", fontSize: "0.85rem" }} />
        <span className="arch-note">
          {mode === 0 ? "Trading-fee rewards for this token are paid to this wallet, forever. Leave blank to use the wallet you launch with." : "In this mode fees go to holders or the burn — this wallet only owns the launch record."}
        </span>
      </div>

      <div style={{ padding: "0.5rem 0", fontSize: "0.875rem" }}>
        <div style={{ display: "flex", justifyContent: "space-between", padding: "0.2rem 0" }}>
          <span style={{ color: "var(--arch-text-muted)" }}>Launch fee</span>
          <span>{launchFee.data === undefined ? "—" : launchFee.data === 0n ? "Free — you only pay gas" : `${fmtQuote(launchFee.data)} ${quoteSymbol}`}</span>
        </div>
        {buyAmount > 0n ? (
          <div style={{ display: "flex", justifyContent: "space-between", padding: "0.2rem 0" }}>
            <span style={{ color: "var(--arch-text-muted)" }}>Initial buy</span>
            <span>{fmtQuote(buyAmount)} {quoteSymbol}</span>
          </div>
        ) : null}
        <div style={{ display: "flex", justifyContent: "space-between", padding: "0.2rem 0" }}>
          <span style={{ color: "var(--arch-text-muted)" }}>Your {quoteSymbol} on Arc</span>
          <span>{pairBalance.data !== undefined ? `${fmtQuote(pairBalance.data)} ${quoteSymbol}` : "—"}</span>
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
          {state.step === "approving" ? `Approving ${quoteSymbol}…` : state.step === "launching" ? "Launching…" : "Launch token"}
        </button>
      )}
      {state.step === "error" ? <p className="arch-note" style={{ color: "var(--arch-negative)" }}>{state.message}</p> : null}
    </div>
  );
}
