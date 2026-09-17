"use client";

import { useMemo, useRef, useState } from "react";
import { CreatorFeeDestination, type FeeDestination } from "@/components/CreatorFeeDestination";
import { useRouter } from "next/navigation";
import { useAccount, usePublicClient, useReadContract, useSwitchChain, useWriteContract } from "wagmi";
import { decodeEventLog, parseAbiItem, type Hex } from "viem";
import { formatUnits, parseUnits } from "viem";
import { erc20Abi } from "@/lib/bridgeClient";
import { factoryAbi, launchpadV4Abi, launchedV4Event, LAUNCH_MODES } from "@/lib/launchpad";
import { compressImage } from "@/lib/imageCompress";
import { getChain } from "@/lib/chains";
import { ArcaneWandIcon, DiviumBillsIcon, StandardWalletIcon } from "@/components/ModeIcons";
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

/**
 * Live launch form. A token is created on the selected chain, paired with that
 * chain's quote asset (native USDC), with its Uniswap v3 pool and locked
 * liquidity in one atomic transaction. Launching is free (network gas only);
 * any optional initial buy is paid in the pair token — which on Arc is the
 */
export function CreateForm() {
  const router = useRouter();
  const { address, isConnected, chainId } = useAccount();
  const { switchChainAsync } = useSwitchChain();
  const { writeContractAsync } = useWriteContract();
  const { toast } = useToast();

  // Arcanium launches on Arc. Reading it from the URL forced this client
  // component into a search-params bailout, so the whole form rendered as a
  // skeleton on the server for no benefit.
  const chain = getChain("arc");
  /**
   * Which Uniswap to launch on. Both stay available.
   *
   * v4 is the default because it is strictly better for a new token: the fee
   * is taken inside the swap, so payouts and burns happen in the same
   * transaction as the trade instead of waiting for a keeper, a tax is
   * possible at all, and liquidity is locked by a contract with no withdrawal
   * code rather than by a vault that promises not to use one.
   *
   * v3 is kept because it is the venue every existing Arcanium token trades
   * on, and therefore the one aggregators and terminals already know how to
   * route. Until they index v4 on Arc, a v3 launch is the more discoverable
   * one, and that is a real reason to choose it.
   *
   * An undefined v4 address means the path does not exist on this deployment,
   * which forces v3 rather than guessing an address.
   */
  const v4Addr = chain.v4?.launchpad;
  const [protocol, setProtocol] = useState<"v3" | "v4">(v4Addr === undefined ? "v3" : "v4");
  const useV4 = protocol === "v4" && v4Addr !== undefined;
  const factory = useV4 ? v4Addr : chain.factories[0];
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
  /** Set when the creator chooses to pay an X account instead of a wallet. */
  const [feeDest, setFeeDest] = useState<FeeDestination | null>(null);
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

  /**
   * The trade tax, offered on v4 and refused on v3.
   *
   * On v3 a tax makes a token unsellable. Uniswap v3 takes a sell's input by
   * transferring into the pool and then checking it received what it was
   * promised, and an ERC-20 transfer tax skims exactly that transfer, so every
   * sell reverts with IIA — a honeypot in two clicks.
   *
   * The v4 hook does not have the problem, because it takes its fee inside the
   * swap through afterSwap rather than skimming a transfer: the pool always
   * receives precisely what it was promised. ArcaniumHook.t.sol sells a token
   * carrying 5% to prove it, and Modes.t.sol pins the v3 revert so the two
   * cannot be confused again.
   */
  const [taxPct, setTaxPct] = useState("0");

  const taxBps = useMemo<bigint | null>(() => {
    if (!useV4) return 0n;
    const raw = taxPct.trim();
    if (raw === "") return 0n;
    if (!/^\d{0,2}(\.\d{1,2})?$/.test(raw)) return null;
    const [whole = "0", frac = ""] = raw.split(".");
    // Parsed in integer arithmetic so 2.9% is 290 rather than 289.
    const bps = BigInt(whole) * 100n + BigInt((frac + "00").slice(0, 2));
    return bps > 900n ? null : bps;
  }, [taxPct, useV4]);

  const formError = ((): string | null => {
    if (name.trim().length === 0) return null;
    if (name.trim().length > 48) return "Name too long (max 48)";
    if (tickerNormalized.length < 2) return "Ticker needs 2–10 letters/numbers";
    if (!validUrl(website) || !validUrl(twitter) || !validUrl(telegram)) {
      return "Links must be https:// URLs";
    }
    if (taxBps === null) return "Trade tax must be between 0% and 9%";
    if (feeDest?.kind === "x") {
      // Binding a fee stream to an identity we could not confirm is the one
      // mistake here with no recovery — the recipient is immutable once
      // launched — so an unresolved handle blocks the launch rather than
      // falling back to a wallet.
      if (feeDest.resolved.vault === "0x") return "Verify the X account before launching";
    } else if (!feeWalletValid) {
      return "Fee recipient must be a valid 0x address";
    }
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

      // v4 takes payment as value, because Arc's USDC is a view of the native
      // balance — so there is nothing to approve and a launch with a first buy
      // is one signature rather than two. v3 has to pull it, and does need one.
      if (!useV4) {
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
      }

      setState({ step: "launching" });
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
      // An X destination resolves to its vault address, which is a real
      // address before the contract exists — that is what makes this possible
      // without changing the deployed factory.
      const feeRecipient = (feeDest?.kind === "x"
        ? feeDest.resolved.vault
        : feeWalletValid && feeWalletTrimmed !== ""
          ? feeWalletTrimmed
          : "0x0000000000000000000000000000000000000000") as Hex;

      const txHash = useV4
        ? await writeContractAsync({
            address: factory,
            abi: launchpadV4Abi,
            functionName: "launch",
            args: [{
              name: name.trim(), symbol: tickerNormalized, metadataUri,
              creatorBuyAmount: buyAmount, minTokensOut: 0n, deadline,
              feeRecipient, taxBps: Number(taxBps ?? 0n), mode,
            }],
            // The fee and the opening buy ride along as value. Arc's native
            // balance is 18-decimal where the ERC-20 view is 6, so the amount
            // is scaled up by 1e12; the launchpad refunds any remainder in the
            // same call rather than keeping it.
            value: needed * 10n ** 12n,
            chainId: chain.id,
          })
        : await writeContractAsync({
            address: factory, abi: factoryAbi, functionName: "launch",
            args: [{
              name: name.trim(), symbol: tickerNormalized, metadataUri, pairToken: quote,
              creatorBuyAmount: buyAmount, minTokensOut: 0n, deadline,
              feeRecipient, taxBps: taxBps ?? 0n, mode,
            }],
            chainId: chain.id,
          });
      const receipt = await chainPublic.waitForTransactionReceipt({ hash: txHash });
      if (receipt.status !== "success") { setState({ step: "error", message: "Launch transaction reverted" }); return; }
      // Both event shapes, because they are different events that share a
      // name: v4's Launched carries a pool id where v3's carries a pool
      // address. Decoding only the v3 one left every v4 launch with no token
      // address here, so its metadata — the logo included — was never saved
      // and the token rendered without a picture.
      let newToken: string | null = null;
      for (const log of receipt.logs) {
        try {
          newToken = decodeEventLog({ abi: [launchedEvent], data: log.data, topics: log.topics }).args.token;
          break;
        } catch { /* not the v3 event */ }
        try {
          newToken = decodeEventLog({ abi: [launchedV4Event], data: log.data, topics: log.topics }).args.token;
          break;
        } catch { /* nor the v4 one */ }
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
    <div className="create-grid">
      <div className="create-form cf">
        {/* A launch is three decisions taken in order — what the token is, how
            it opens, who its fees pay. The numbering is not decoration: the
            order is real, and the third is the only irreversible one. */}
        <Step n={1} title="Your token" />

        <div className="cf-row cf-two">
          <Field id="cf-name" label="Name">
            <input id="cf-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Archway" disabled={busy} maxLength={48} />
          </Field>
          <Field id="cf-ticker" label="Ticker">
            <input id="cf-ticker" value={ticker} onChange={(e) => setTicker(e.target.value)} placeholder="ARCH" disabled={busy} maxLength={10} />
          </Field>
        </div>

        <div className="cf-row">
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            style={{ display: "none" }}
            onChange={(e) => void onPickImage(e.target.files?.[0])}
            disabled={busy}
          />
          <button type="button" className="cf-logo" onClick={() => fileRef.current?.click()} disabled={busy}>
            <span
              aria-hidden
              className="cf-logo-thumb"
              style={imageUrl === "" ? undefined : { background: `center/cover no-repeat url(${JSON.stringify(imageUrl)})`, border: "none" }}
            />
            <span className="cf-logo-text">
              {imageUrl === "" ? "Add a logo" : "Change logo"}
              <span>PNG, JPG or WebP. We resize it.</span>
            </span>
          </button>
          {imgError !== null ? <p className="err" style={{ margin: "4px 0 0" }}>{imgError}</p> : null}
        </div>

        <details className="cf-more">
          <summary>Description and links</summary>
          <Field id="cf-desc" label="Description">
            <textarea id="cf-desc" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} disabled={busy} maxLength={500} />
          </Field>
          <div className="cf-row cf-two">
            <Field id="cf-web" label="Website">
              <input id="cf-web" value={website} onChange={(e) => setWebsite(e.target.value)} placeholder="https://…" disabled={busy} />
            </Field>
            <Field id="cf-x" label="X">
              <input id="cf-x" value={twitter} onChange={(e) => setTwitter(e.target.value)} placeholder="https://x.com/…" disabled={busy} />
            </Field>
          </div>
          <Field id="cf-tg" label="Telegram">
            <input id="cf-tg" value={telegram} onChange={(e) => setTelegram(e.target.value)} placeholder="https://t.me/…" disabled={busy} />
          </Field>
        </details>

        <Step n={2} title="How it opens" />

        <div className="cf-row cf-two">
          <Field id="cf-buy" label={`Your first buy (${quoteSymbol})`} hint="Bought inside the launch, so nobody gets in ahead of you.">
            <input id="cf-buy" value={creatorBuy} onChange={(e) => setCreatorBuy(e.target.value)} placeholder="0.00" inputMode="decimal" disabled={busy} />
          </Field>

          {v4Addr === undefined ? null : (
            <Field
              label="Pool"
              hint={
                protocol === "v4"
                  ? "Newer. Rewards pay out instantly and you can add a trade tax."
                  : "Older. Every Arcanium token so far uses it. No trade tax."
              }
            >
              <div className="cf-toggle">
                {(["v4", "v3"] as const).map((p) => (
                  <button
                    key={p}
                    type="button"
                    className={protocol === p ? "on" : undefined}
                    onClick={() => setProtocol(p)}
                    disabled={busy}
                    aria-pressed={protocol === p}
                  >
                    Uniswap {p}
                  </button>
                ))}
              </div>
            </Field>
          )}
        </div>

        {!useV4 ? null : (
          <div className="cf-row">
            <Field
              id="cf-tax"
              label="Trade tax"
              hint={
                taxBps !== null && taxBps > 0n
                  ? `Every trade costs ${(Number(taxBps) / 100 + 1).toFixed(2)}% in total. The extra follows your choice below.`
                  : "Optional. An extra cut on every trade, on top of the 1% pool fee."
              }
            >
              <div className="cf-suffix">
                <input id="cf-tax" value={taxPct} onChange={(e) => setTaxPct(e.target.value)} placeholder="0" inputMode="decimal" disabled={busy} />
                <span>% · max 9</span>
              </div>
            </Field>
          </div>
        )}

        <Step n={3} title="Who the fees pay" note="Fixed at launch — this one cannot be changed later." />

        <div className="cf-modes">
          {LAUNCH_MODES.map((m) => {
            const active = mode === m.id;
            return (
              <button
                key={m.key}
                type="button"
                disabled={busy}
                onClick={() => setMode(m.id as 0 | 1 | 2)}
                className={active ? "mode-card mode-card-on" : "mode-card"}
                aria-pressed={active}
              >
                <span aria-hidden className="cf-mode-icon">
                  {m.id === 1 ? <DiviumBillsIcon size={22} /> : m.id === 2 ? <ArcaneWandIcon size={22} /> : <StandardWalletIcon size={22} />}
                </span>
                <span style={{ minWidth: 0 }}>
                  <span className="cf-mode-name">{m.label}</span>
                  <span className="cf-mode-blurb">{MODE_PLAIN[m.id] ?? m.blurb}</span>
                </span>
              </button>
            );
          })}
        </div>

        <details className="cf-more">
          <summary>Send fees somewhere other than my wallet</summary>
          <CreatorFeeDestination
            walletAddress={address ?? ""}
            tokenXHandle={twitter}
            disabled={busy}
            onChange={(d) => {
              setFeeDest(d);
              if (d?.kind === "wallet") setFeeWallet(d.address);
            }}
          />
          {mode === 0 ? null : (
            <p className="cf-hint" style={{ marginTop: "var(--s2)" }}>
              In this mode the fees go to holders or the burn, so this only records who launched it.
            </p>
          )}
        </details>
      </div>

      {/* Persistent economics. Everything that will happen, before signing. */}
      <aside className="create-side">
        <section className="panel">
          <div className="panel-head">
            <span className="eyebrow">Launch summary</span>
          </div>
          <div className="panel-body" style={{ display: "grid", gap: 0 }}>
            <SummaryRow label="Chain" value={chain.name} />
            <SummaryRow label="Pair" value={chain.quote.symbol} />
            <SummaryRow label="Supply" value="1,000,000,000 fixed" />
            <SummaryRow label="Pool" value={useV4 ? "Uniswap v4 · 1% fee" : "Uniswap v3 · 1% fee"} />
            <SummaryRow label="Liquidity" value="Locked forever" />
            <SummaryRow label="Fees pay" value={mode === 1 ? "Holders" : mode === 2 ? "Buy and burn" : "You"} />
            {!useV4 ? null : (
              <SummaryRow
                label="Trade tax"
                value={taxBps === null ? "—" : taxBps === 0n ? "None" : `${(Number(taxBps) / 100).toFixed(2)}%`}
              />
            )}
            <SummaryRow label="Your first buy" value={buyAmount > 0n ? `${fmtQuote(buyAmount)} ${quoteSymbol}` : "None"} />
            <SummaryRow
              label="Cost to launch"
              value={
                launchFee.data === undefined
                  ? "—"
                  : launchFee.data === 0n
                    ? "Gas only"
                    : `${fmtQuote(launchFee.data)} ${quoteSymbol}`
              }
            />
            <SummaryRow
              label={`Your ${quoteSymbol}`}
              value={pairBalance.data !== undefined ? `${fmtQuote(pairBalance.data)} ${quoteSymbol}` : "—"}
            />
          </div>

          <div className="panel-body" style={{ borderTop: "1px solid var(--border)", display: "grid", gap: "var(--s2)" }}>
            {formError !== null ? <p className="err" style={{ margin: 0 }}>{formError}</p> : null}

            {state.step === "needs_gas" ? (
              <p className="err" style={{ margin: 0, color: "var(--warning)" }}>
                You need a little Arc gas ({quoteSymbol}) first. Top up, then press Launch again.
              </p>
            ) : null}

            {!isConnected ? (
              <ConnectButton />
            ) : (
              <button
                className="btn btn-primary btn-lg"
                style={{ width: "100%" }}
                disabled={disabled}
                onClick={() => void submit()}
              >
                {state.step === "approving"
                  ? `Approving ${quoteSymbol}…`
                  : state.step === "launching"
                    ? "Launching…"
                    : "Launch token"}
              </button>
            )}

            {state.step === "error" ? <p className="err" style={{ margin: 0 }}>{state.message}</p> : null}

            <p className="cf-hint" style={{ margin: 0 }}>
              One transaction. Your wallet shows exactly what it signs.
            </p>
          </div>
        </section>
      </aside>
    </div>
  );
}

/**
 * The reward modes, said the way somebody would say them out loud.
 *
 * The canonical blurbs in LAUNCH_MODES are written for the docs, where
 * precision earns its length. Here the reader is mid-decision and comparing
 * three options, so each has to be short enough to hold all three at once.
 */
const MODE_PLAIN: Record<number, string> = {
  0: "Straight to your wallet, in USDC.",
  1: "Split between everyone holding the token, in USDC.",
  2: "Buys your token off the market and burns it.",
};

/** A numbered step heading. A signpost, so it is sized like one. */
function Step({ n, title, note }: { readonly n: number; readonly title: string; readonly note?: string }) {
  return (
    <div className="cf-step">
      <span className="cf-step-n" aria-hidden>{n}</span>
      <h2>{title}</h2>
      {note === undefined ? null : <span className="cf-step-note">{note}</span>}
    </div>
  );
}

/**
 * One labelled control.
 *
 * `hint` is deliberately the exception rather than the habit. Every field used
 * to carry a paragraph of grey explanation beneath it, and the sum of them
 * turned the form into small print that buried the fields it was explaining. A
 * hint belongs here only when it changes what the reader would type.
 */
function Field({
  id,
  label,
  hint,
  children,
}: {
  readonly id?: string;
  readonly label: string;
  readonly hint?: string;
  readonly children: React.ReactNode;
}) {
  return (
    <div className="cf-field">
      {id === undefined ? <span className="cf-label">{label}</span> : <label htmlFor={id}>{label}</label>}
      {children}
      {hint === undefined ? null : <span className="cf-hint">{hint}</span>}
    </div>
  );
}

function SummaryRow({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div
      className="spread"
      style={{ padding: "7px 0", borderBottom: "1px solid var(--border)", fontSize: "0.82rem" }}
    >
      <span style={{ color: "var(--text-secondary)" }}>{label}</span>
      <span className="num" style={{ fontWeight: 600, textAlign: "right" }}>{value}</span>
    </div>
  );
}
