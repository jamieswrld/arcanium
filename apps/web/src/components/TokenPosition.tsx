"use client";

import { useEffect, useState } from "react";
import { useAccount, useReadContract } from "wagmi";
import type { Hex } from "viem";
import { erc20Abi } from "viem";
import { formatPriceE18, formatUsdCompact } from "@/lib/launchpad";

/**
 * The connected wallet's position in the token being viewed.
 *
 * The portfolio answers "what do I hold"; this answers "how am I doing in
 * *this* market", which is the question actually being asked while looking at
 * one. Balance comes from the chain — the only source that accounts for tokens
 * moved in or out by plain transfer — while cost basis comes from the indexer's
 * record of this wallet's trades.
 *
 * Those two can legitimately disagree, and when they do this says so rather
 * than reporting a confident and wrong profit. A balance larger than everything
 * the wallet bought means tokens arrived some other way, and there is no honest
 * cost basis for them.
 */

interface PositionJson {
  readonly bought: { readonly tokens: string; readonly usdUnits: string; readonly trades: number };
  readonly sold: { readonly tokens: string; readonly usdUnits: string; readonly trades: number };
  readonly firstTradeAt: string | null;
}

export interface TokenPositionProps {
  readonly token: Hex;
  readonly symbol: string;
  /** Current price, USD per whole token, scaled 1e18. */
  readonly priceE18: bigint;
}

const WEI = 10n ** 18n;
/** 6-decimal USD micro-units -> the 1e18 scale prices are carried at. */
const MICRO_TO_E18 = 10n ** 12n;

/** USD value, in 6-decimal micro-units, of `amount` wei at a 1e18 price. */
function usdUnitsOf(amount: bigint, priceE18: bigint): bigint {
  return (amount * priceE18) / WEI / MICRO_TO_E18;
}

export function TokenPosition({ token, symbol, priceE18 }: TokenPositionProps) {
  const { address, isConnected } = useAccount();
  const [pos, setPos] = useState<PositionJson | null>(null);
  const [asked, setAsked] = useState(false);

  const { data: balance } = useReadContract({
    address: token,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: address === undefined ? undefined : [address],
    query: { enabled: address !== undefined, refetchInterval: 15_000 },
  });

  useEffect(() => {
    if (address === undefined) return undefined;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/tokens/${token}/position?wallet=${address}`, { cache: "no-store" });
        if (!res.ok) return;
        const body = (await res.json()) as PositionJson;
        if (!cancelled) setPos(body);
      } catch {
        // The panel degrades to balance-only; nothing here is load-bearing.
      } finally {
        if (!cancelled) setAsked(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token, address]);

  if (!isConnected || address === undefined) return null;

  const held = balance ?? 0n;
  // Nothing held and nothing ever traded: this wallet has no relationship with
  // the token, and an empty panel is worse than no panel.
  if (held === 0n && (pos === null || pos.bought.trades === 0)) return null;

  const valueUnits = usdUnitsOf(held, priceE18);
  const boughtTokens = pos === null ? 0n : BigInt(pos.bought.tokens);
  const boughtUsd = pos === null ? 0n : BigInt(pos.bought.usdUnits);
  const soldTokens = pos === null ? 0n : BigInt(pos.sold.tokens);
  const soldUsd = pos === null ? 0n : BigInt(pos.sold.usdUnits);

  // Average price paid per whole token, carried at 1e18 like every other price
  // here. Six-decimal USD is far too coarse for this: a token at $0.0000067
  // truncates to $0.000006, and the error lands straight in the P&L.
  const avgCostE18 =
    boughtTokens > 0n ? (boughtUsd * MICRO_TO_E18 * WEI) / boughtTokens : null;
  const netTokens = boughtTokens - soldTokens;
  // A balance materially above what was bought means tokens arrived by transfer,
  // so no cost basis covers them. 1% of tolerance absorbs rounding and the tax
  // taken on a taxed transfer, rather than flagging every ordinary position.
  const untracked = boughtTokens > 0n && held > netTokens + netTokens / 100n;

  const basisUnits = avgCostE18 === null ? null : usdUnitsOf(held, avgCostE18);
  const unrealised = basisUnits === null || untracked ? null : valueUnits - basisUnits;
  const realised =
    soldTokens > 0n && avgCostE18 !== null ? soldUsd - usdUnitsOf(soldTokens, avgCostE18) : null;

  return (
    <section className="panel pos-panel">
      <div className="spread" style={{ alignItems: "baseline", gap: "var(--s2)" }}>
        <h2 className="eyebrow">Your position</h2>
        {pos !== null && pos.bought.trades + pos.sold.trades > 0 ? (
          <span className="arch-note">
            {pos.bought.trades + pos.sold.trades} trade
            {pos.bought.trades + pos.sold.trades === 1 ? "" : "s"}
          </span>
        ) : null}
      </div>

      <div className="pos-grid">
        <Figure label="Holding" value={`${fmtTokens(held)} ${symbol}`} />
        <Figure label="Value" value={formatUsdCompact(valueUnits)} />
        <Figure
          label="Avg. paid"
          value={avgCostE18 === null ? "—" : formatPriceE18(avgCostE18)}
          hint={avgCostE18 === null ? "No buys recorded" : undefined}
        />
        <Figure
          label="Unrealised"
          value={unrealised === null ? "—" : signed(unrealised)}
          tone={unrealised === null ? undefined : unrealised >= 0n ? "pos" : "neg"}
          hint={untracked ? "Balance exceeds recorded buys" : undefined}
        />
        {realised === null ? null : (
          <Figure
            label="Realised"
            value={signed(realised)}
            tone={realised >= 0n ? "pos" : "neg"}
          />
        )}
      </div>

      {untracked ? (
        <p className="arch-note" style={{ marginTop: "var(--s2)" }}>
          You hold more {symbol} than this wallet bought here, so some of it arrived by transfer.
          There is no purchase price for those tokens, and no honest profit to quote on them.
        </p>
      ) : null}
      {asked && pos === null ? (
        <p className="arch-note" style={{ marginTop: "var(--s2)" }}>
          Trade history needs the indexer, which is not currently caught up. Your balance above is
          read straight from the chain and is correct.
        </p>
      ) : null}
    </section>
  );
}

/** Whole tokens, grouped. Fractions of a token are noise at these supplies. */
function fmtTokens(raw: bigint): string {
  return (raw / WEI).toLocaleString("en-US");
}

function signed(units: bigint): string {
  const sign = units < 0n ? "-" : "+";
  return `${sign}${formatUsdCompact(units < 0n ? -units : units)}`;
}

function Figure({
  label,
  value,
  tone,
  hint,
}: {
  readonly label: string;
  readonly value: string;
  readonly tone?: "pos" | "neg" | undefined;
  readonly hint?: string | undefined;
}) {
  return (
    <div>
      <div className="arch-stat-label">{label}</div>
      <div
        className="arch-stat-value"
        title={hint}
        style={{
          color: tone === "pos" ? "var(--positive)" : tone === "neg" ? "var(--negative)" : undefined,
        }}
      >
        {value}
      </div>
    </div>
  );
}
