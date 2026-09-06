"use client";

import { useEffect, useMemo, useState } from "react";
import { useAccount, useBalance, usePublicClient, useWriteContract } from "wagmi";
import { formatUnits, parseAbiItem, type Hex } from "viem";
import { erc20Abi } from "@/lib/bridgeClient";
import { formatUsdCompact } from "@/lib/launchpad";
import { getChain, type ChainKey } from "@/lib/chains";
import { TokenAvatar } from "@/components/TokenAvatar";
import { UsdcLogo } from "@/components/UsdcLogo";
import { ConnectButton } from "@/components/ConnectButton";
import { NetworkNotice } from "@/components/NetworkNotice";
import { useToast } from "@/components/ui/Toast";
import Link from "next/link";

export interface SerializedToken {
  readonly token: Hex;
  readonly name: string;
  readonly symbol: string;
  readonly creator: Hex;
  readonly pairToken: Hex;
  readonly pool: Hex;
  readonly positionId: string;
  readonly priceE18: string;
  readonly graduated: boolean;
  readonly image: string | null;
}

const vaultAbi = [
  { type: "function", name: "collectFees", stateMutability: "nonpayable", inputs: [{ type: "uint256" }], outputs: [{ type: "uint256" }, { type: "uint256" }] },
] as const;
const distributorAbi = [
  { type: "function", name: "creatorShareBps", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "distribute", stateMutability: "nonpayable", inputs: [{ type: "address" }], outputs: [] },
] as const;
const feesDistributedEvent = parseAbiItem(
  "event FeesDistributed(address indexed token, address indexed pairToken, uint256 tokenFeesBurned, uint256 creatorReward, uint256 protocolReward)",
);

/** Every distributor generation — claimed-rewards history spans all of them. */
const ALL_DISTRIBUTORS: Hex[] = [
  "0x789896401c1c90df95757dfd3228989b627418b4",
  "0xbdc362f9ddea2ae9c39b108e0712f7d6e2f00e5f",
];

const CHUNK = 45_000n;
const MAX_CHUNKS = 10;

interface CreatorRow {
  readonly pendingCreator: bigint;
  readonly pendingGross: bigint;
  readonly claimedCreator: bigint;
  readonly claimedGross: bigint;
}

function Eyebrow({ children }: { readonly children: React.ReactNode }) {
  return (
    <div style={{ color: "var(--accent)", fontSize: "0.72rem", fontWeight: 700, letterSpacing: "0.14em", textTransform: "uppercase", marginBottom: "0.4rem" }}>
      {children}
    </div>
  );
}

/**
 * Wallet dashboard: headline stats, launch-token holdings, and the creator
 * center with per-token pending/claimed rewards and one-click claims.
 * All money math is bigint; floats appear only at render.
 */
/**
 * "You created this" mark.
 *
 * Was a literal crown emoji, which renders as full-colour vendor artwork and
 * sits badly against a monochrome line-icon set. Drawn the same way as the
 * social icons — one stroke weight, currentColor — so it takes the accent from
 * whatever it sits in.
 */
function CreatorMark() {
  return (
    <svg
      width={12}
      height={12}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinejoin="round"
      aria-hidden
      style={{ color: "var(--accent)", verticalAlign: "-1px" }}
    >
      <title>Created by you</title>
      <path d="M3 7l4.5 4L12 4l4.5 7L21 7l-1.8 10H4.8L3 7z" />
    </svg>
  );
}

export function PortfolioDashboard({
  tokens,
  chainKey = "arc",
}: {
  readonly tokens: readonly SerializedToken[];
  readonly chainKey?: ChainKey;
}) {
  // Everything here is scoped to one chain: balances, creator rewards and the
  // distributor all live on the chain the tokens were launched on.
  const chain = getChain(chainKey);
  const DISTRIBUTOR_ADDRESS = chain.modeDistributor;
  const LIQUIDITY_VAULT_ADDRESS = chain.liquidityVault;
  const PAIR_TOKEN_SYMBOL = chain.quote.symbol;
  const formatQuoteUnits = (v: bigint): string => formatUnits(v, chain.quote.decimals);
  const { address, isConnected } = useAccount();
  const arcPublic = usePublicClient({ chainId: chain.id });
  const { writeContractAsync } = useWriteContract();
  const { toast } = useToast();

  const native = useBalance({ address, chainId: chain.id, query: { enabled: address !== undefined, refetchInterval: 12_000 } });
  const [balances, setBalances] = useState<Record<string, bigint>>({});
  const [balancesReady, setBalancesReady] = useState(false);
  const [rewards, setRewards] = useState<Record<string, CreatorRow>>({});
  const [claiming, setClaiming] = useState<string | null>(null);

  const created = useMemo(
    () => (address === undefined ? [] : tokens.filter((t) => t.creator.toLowerCase() === address.toLowerCase())),
    [tokens, address],
  );

  // Holdings: balanceOf across the launch universe, refreshed continuously.
  useEffect(() => {
    if (arcPublic === undefined || address === undefined) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async (): Promise<void> => {
      const entries = await Promise.all(
        tokens.map(async (t) => [t.token.toLowerCase(), await arcPublic.readContract({ address: t.token, abi: erc20Abi, functionName: "balanceOf", args: [address] }).catch(() => 0n)] as const),
      );
      if (!cancelled) {
        setBalances(Object.fromEntries(entries));
        setBalancesReady(true);
      }
      if (!cancelled) timer = setTimeout(() => void tick(), 12_000);
    };
    void tick();
    return () => { cancelled = true; if (timer !== undefined) clearTimeout(timer); };
  }, [arcPublic, address, tokens]);

  // Creator rewards: pending via simulated collect; claimed via distributor
  // event history (all generations, chunked walk).
  useEffect(() => {
    if (arcPublic === undefined || address === undefined || created.length === 0) return;
    if (DISTRIBUTOR_ADDRESS === undefined || LIQUIDITY_VAULT_ADDRESS === undefined) return;
    const distributor = DISTRIBUTOR_ADDRESS;
    const vault = LIQUIDITY_VAULT_ADDRESS;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const claimedByToken = new Map<string, { creator: bigint; gross: bigint }>();
    let claimedLoaded = false;

    const loadClaimed = async (): Promise<void> => {
      claimedByToken.clear();
      const tip = await arcPublic.getBlockNumber();
      let end = tip;
      for (let i = 0; i < MAX_CHUNKS; i++) {
        const start = end >= CHUNK ? end - CHUNK + 1n : 0n;
        let logs;
        try {
          logs = await arcPublic.getLogs({
            address: ALL_DISTRIBUTORS,
            event: feesDistributedEvent,
            args: { token: created.map((c) => c.token) },
            fromBlock: start,
            toBlock: end,
          });
        } catch { break; }
        for (const l of logs) {
          const k = (l.args.token ?? "0x").toLowerCase();
          const prev = claimedByToken.get(k) ?? { creator: 0n, gross: 0n };
          const cr = l.args.creatorReward ?? 0n;
          const pr = l.args.protocolReward ?? 0n;
          claimedByToken.set(k, { creator: prev.creator + cr, gross: prev.gross + cr + pr });
        }
        if (start === 0n) break;
        end = start - 1n;
      }
      claimedLoaded = true;
    };

    const tick = async (): Promise<void> => {
      try {
        if (!claimedLoaded) await loadClaimed();
        const share = await arcPublic.readContract({ address: distributor, abi: distributorAbi, functionName: "creatorShareBps" });
        const rows = await Promise.all(
          created.map(async (c) => {
            const sim = await arcPublic
              .simulateContract({ address: vault, abi: vaultAbi, functionName: "collectFees", args: [BigInt(c.positionId)], account: distributor })
              .then((r) => r.result)
              .catch(() => [0n, 0n] as const);
            const tokenIs0 = c.token.toLowerCase() < c.pairToken.toLowerCase();
            const pendingGross = tokenIs0 ? sim[1] : sim[0];
            const claimed = claimedByToken.get(c.token.toLowerCase()) ?? { creator: 0n, gross: 0n };
            return [c.token.toLowerCase(), {
              pendingCreator: (pendingGross * share) / 10_000n,
              pendingGross,
              claimedCreator: claimed.creator,
              claimedGross: claimed.gross,
            }] as const;
          }),
        );
        if (!cancelled) setRewards(Object.fromEntries(rows));
      } catch { /* transient */ }
      if (!cancelled) timer = setTimeout(() => void tick(), 15_000);
    };
    void tick();
    return () => { cancelled = true; if (timer !== undefined) clearTimeout(timer); };
  }, [arcPublic, address, created]);

  async function claim(token: Hex): Promise<void> {
    if (arcPublic === undefined || DISTRIBUTOR_ADDRESS === undefined) return;
    setClaiming(token.toLowerCase());
    try {
      const txHash = await writeContractAsync({ address: DISTRIBUTOR_ADDRESS, abi: distributorAbi, functionName: "distribute", args: [token], chainId: chain.id });
      const receipt = await arcPublic.waitForTransactionReceipt({ hash: txHash });
      if (receipt.status === "success") {
        toast({ tone: "success", title: "Rewards claimed", description: "Your creator share was sent to your wallet." });
        setRewards((prev) => {
          const k = token.toLowerCase();
          const row = prev[k];
          if (row === undefined) return prev;
          return { ...prev, [k]: { pendingCreator: 0n, pendingGross: 0n, claimedCreator: row.claimedCreator + row.pendingCreator, claimedGross: row.claimedGross + row.pendingGross } };
        });
      } else {
        toast({ tone: "error", title: "Claim failed", description: "The transaction reverted." });
      }
    } catch (err) {
      const message = err instanceof Error ? (err.message.split("\n")[0] ?? "failed") : "failed";
      toast({ tone: "error", title: message.toLowerCase().includes("rejected") ? "Rejected in wallet" : "Claim failed", description: message.toLowerCase().includes("rejected") ? undefined : message });
    } finally {
      setClaiming(null);
    }
  }

  if (!isConnected || address === undefined) {
    return (
      <div className="arch-stack" style={{ maxWidth: 720, margin: "0 auto" }}>
        <div>
          <Eyebrow>Your onchain dashboard · Arc</Eyebrow>
          <h1 style={{ margin: 0, fontSize: "2.6rem", fontWeight: 800, letterSpacing: "-0.03em" }}>Portfolio</h1>
          <p className="arch-note" style={{ margin: "0.5rem 0 0", maxWidth: 520 }}>
            Token holdings, launches, and creator rewards for the connected wallet.
          </p>
        </div>
        <section className="arch-card">
          <p className="arch-note" style={{ margin: 0 }}>Connect your wallet to see your holdings and creator rewards.</p>
          <div style={{ marginTop: "0.85rem", maxWidth: 240 }}>
            <ConnectButton />
          </div>
        </section>
      </div>
    );
  }

  // Derived figures — all bigint 6-decimal USD units.
  const held = tokens.filter((t) => (balances[t.token.toLowerCase()] ?? 0n) > 0n);
  const tokenValue = held.reduce((acc, t) => {
    const bal = balances[t.token.toLowerCase()] ?? 0n;
    return acc + (bal * BigInt(t.priceE18)) / 10n ** 30n;
  }, 0n);
  const usdcUnits = native.data !== undefined ? native.data.value / 10n ** 12n : 0n;
  const portfolioValue = usdcUnits + tokenValue;
  const availableTotal = Object.values(rewards).reduce((a, r) => a + r.pendingCreator, 0n);
  const claimedTotal = Object.values(rewards).reduce((a, r) => a + r.claimedCreator, 0n);

  const tile = (label: string, value: string, caption: string, highlight = false): React.ReactNode => (
    <div className="arch-stat-tile" style={highlight ? { borderColor: "color-mix(in oklch, var(--primary) 55%, var(--border))", boxShadow: "var(--shadow-sm), 0 0 24px oklch(0.58 0.24 295 / 0.15)" } : undefined}>
      <div className="arch-stat-label">{label}</div>
      <div className="arch-stat-value">{value}</div>
      <div className="arch-note" style={{ fontSize: "0.72rem", marginTop: 2 }}>{caption}</div>
    </div>
  );

  return (
    <div className="arch-stack">
      <NetworkNotice />

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", gap: "1rem", flexWrap: "wrap" }}>
        <div>
          <Eyebrow>Your onchain dashboard · Arc</Eyebrow>
          <h1 style={{ margin: 0, fontSize: "2.6rem", fontWeight: 800, letterSpacing: "-0.03em" }}>Portfolio</h1>
          <p className="arch-note" style={{ margin: "0.5rem 0 0", maxWidth: 560 }}>
            Token holdings, launches, and creator rewards for the connected wallet on Arc.
          </p>
        </div>
        <span style={{ display: "inline-flex", alignItems: "center", gap: "0.5rem", border: "1px solid var(--border)", borderRadius: 999, padding: "0.5rem 0.95rem", background: "var(--card)", fontFamily: "monospace", fontWeight: 700, fontSize: "0.9rem" }}>
          <span aria-hidden style={{ width: 8, height: 8, borderRadius: 999, background: "var(--positive)", boxShadow: "0 0 8px var(--positive)" }} />
          {address.slice(0, 6)}…{address.slice(-4)}
        </span>
      </div>

      <div className="arch-stat-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))" }}>
        {tile("Portfolio value", `${formatUsdCompact(portfolioValue)}`, "USDC + launch tokens, live")}
        {tile("Tokens held", String(held.length), "Arcanium launches in this wallet")}
        {tile("Tokens created", String(created.length), "Launched by this wallet")}
        {tile("Creator rewards available", `${formatQuoteUnits(availableTotal)} ${PAIR_TOKEN_SYMBOL}`, `${formatQuoteUnits(claimedTotal)} ${PAIR_TOKEN_SYMBOL} already claimed`, true)}
      </div>

      <section>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: "1rem", flexWrap: "wrap" }}>
          <div>
            <Eyebrow>Assets</Eyebrow>
            <h2 style={{ margin: "0 0 0.75rem", fontSize: "1.5rem", fontWeight: 700, letterSpacing: "-0.02em" }}>Your tokens</h2>
          </div>
          <span className="arch-note" style={{ fontSize: "0.75rem" }}>{balancesReady ? "Live · refreshes every 12s" : "Reading onchain balances…"}</span>
        </div>
        <section className="arch-card">
          <div style={{ display: "grid", gap: "0.25rem" }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: "0.75rem", padding: "0.55rem 0", borderBottom: "1px solid var(--border)", alignItems: "center" }}>
              <span style={{ display: "flex", alignItems: "center", gap: "0.6rem" }}>
                <UsdcLogo size={34} />
                <span><strong>USDC</strong> <span className="arch-note">native · pays gas &amp; trades</span></span>
              </span>
              <span style={{ fontVariantNumeric: "tabular-nums", fontWeight: 600 }}>{formatQuoteUnits(usdcUnits)} ${PAIR_TOKEN_SYMBOL}</span>
            </div>
            {held.length === 0 ? (
              <p className="arch-note" style={{ margin: "1.1rem 0 0.5rem", textAlign: "center" }}>
                {balancesReady ? "No launch tokens in this wallet yet — grab one on the launchpad." : "Reading token balances…"}
              </p>
            ) : (
              held.map((t) => {
                const bal = balances[t.token.toLowerCase()] ?? 0n;
                const value = (bal * BigInt(t.priceE18)) / 10n ** 30n;
                const mine = t.creator.toLowerCase() === address.toLowerCase();
                return (
                  <Link key={t.token} href={`/tokens/${t.token}`} style={{ display: "flex", justifyContent: "space-between", gap: "0.75rem", padding: "0.55rem 0", borderBottom: "1px solid var(--border)", alignItems: "center", color: "inherit", textDecoration: "none" }}>
                    <span style={{ display: "flex", alignItems: "center", gap: "0.6rem", minWidth: 0 }}>
                      <TokenAvatar image={t.image} symbol={t.symbol} size={34} radius={10} />
                      <span style={{ minWidth: 0 }}>
                        <strong>{t.symbol}</strong> {mine ? <CreatorMark /> : null}{" "}
                        <span className="arch-note" style={{ whiteSpace: "nowrap" }}>{t.name}</span>
                      </span>
                    </span>
                    <span style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                      <span style={{ display: "block", fontWeight: 600 }}>{(bal / 10n ** 18n).toLocaleString("en-US")}</span>
                      <span className="arch-note">{formatUsdCompact(value)}</span>
                    </span>
                  </Link>
                );
              })
            )}
          </div>
        </section>
      </section>

      <section>
        <Eyebrow>Creator center</Eyebrow>
        <h2 style={{ margin: 0, fontSize: "1.5rem", fontWeight: 700, letterSpacing: "-0.02em" }}>Creator rewards</h2>
        <p className="arch-note" style={{ margin: "0.35rem 0 0.9rem" }}>
          Creators earn a share of every pool&apos;s 1% Uniswap fees, forever. Claiming distributes all
          shares and burns the token-side fees. Tokens have no transfer tax.
        </p>
        {created.length === 0 ? (
          <section className="arch-card">
            <p className="arch-note" style={{ margin: 0, textAlign: "center" }}>
              No launches from this wallet yet. <Link href="/create" style={{ textDecoration: "underline" }}>Create a token</Link> — it&apos;s free, you only pay gas.
            </p>
          </section>
        ) : (
          <div className="arch-stack">
            {created.map((c) => {
              const r = rewards[c.token.toLowerCase()];
              const pending = r?.pendingCreator ?? 0n;
              const box = (label: string, value: string, highlight = false): React.ReactNode => (
                <div style={{ border: "1px solid var(--border)", borderRadius: 12, padding: "0.7rem 0.85rem", background: highlight ? "color-mix(in oklch, var(--primary) 12%, var(--card))" : "var(--muted)" }}>
                  <div className="arch-stat-label">{label}</div>
                  <div style={{ fontWeight: 700, fontVariantNumeric: "tabular-nums", marginTop: 2 }}>{value}</div>
                </div>
              );
              return (
                <section key={c.token} className="arch-card">
                  <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", marginBottom: "0.9rem" }}>
                    <TokenAvatar image={c.image} symbol={c.symbol} size={46} radius={12} />
                    <div>
                      <strong style={{ fontSize: "1.05rem" }}>{c.name}</strong>
                      <div className="arch-note">
                        ${c.symbol} · Position #{c.positionId} · Created by you <CreatorMark />
                      </div>
                    </div>
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: "0.6rem" }}>
                    {box("Creator rewards earned", r !== undefined ? `${formatQuoteUnits(r.claimedCreator + r.pendingCreator)} ${PAIR_TOKEN_SYMBOL}` : "…")}
                    {box("Already claimed", r !== undefined ? `${formatQuoteUnits(r.claimedCreator)} ${PAIR_TOKEN_SYMBOL}` : "…")}
                    {box("Available now", r !== undefined ? `${formatQuoteUnits(pending)} ${PAIR_TOKEN_SYMBOL}` : "…", true)}
                    {box("Gross pool fees", r !== undefined ? `${formatQuoteUnits(r.claimedGross + r.pendingGross)} ${PAIR_TOKEN_SYMBOL}` : "…")}
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "0.75rem", marginTop: "0.9rem", flexWrap: "wrap", borderTop: "1px solid var(--border)", paddingTop: "0.85rem" }}>
                    <span className="arch-note" style={{ fontFamily: "monospace" }}>Payout wallet {address.slice(0, 6)}…{address.slice(-4)}</span>
                    <button
                      className="arch-primary-button"
                      style={{ width: "auto", padding: "0.6rem 1.4rem", cursor: pending === 0n || claiming !== null ? "not-allowed" : "pointer", opacity: pending === 0n || claiming !== null ? 0.55 : 1 }}
                      disabled={pending === 0n || claiming !== null}
                      onClick={() => void claim(c.token)}
                    >
                      {claiming === c.token.toLowerCase() ? "Claiming…" : pending === 0n ? "Nothing to claim" : `Claim ${formatQuoteUnits(pending)} ${PAIR_TOKEN_SYMBOL}`}
                    </button>
                  </div>
                </section>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
