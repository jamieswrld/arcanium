"use client";

import { useEffect, useState } from "react";
import { usePublicClient } from "wagmi";
import type { Hex } from "viem";
import { getChain, type ChainKey } from "@/lib/chains";
import { launchTokenAbi } from "@/lib/launchpad";

/**
 * Warns that a token charges a trade tax, and says how much.
 *
 * Creators can now set a tax of up to 9% at launch, on top of the 1% pool fee.
 * That is a real cost a buyer pays and cannot see anywhere else: it is taken
 * inside the token's own transfer, so the pool quote, the router and every
 * aggregator all report the pre-tax amount and the wallet simply receives less
 * than was quoted. Letting creators charge it without showing it would make
 * the interface complicit in a surprise, so this renders wherever the token
 * trades.
 *
 * Renders nothing at 0%, which is almost every token — a notice saying "this
 * token does not do the bad thing" on every page trains people to ignore it.
 *
 * Deliberately not conditional on the launch mode: a taxed token is usually
 * Standard, and TokenMode renders nothing for Standard.
 */
export function TokenTax({
  token,
  chainKey = "arc",
}: {
  readonly token: Hex;
  readonly chainKey?: ChainKey;
}) {
  const chain = getChain(chainKey);
  const client = usePublicClient({ chainId: chain.id });
  const [bps, setBps] = useState<bigint | null>(null);

  useEffect(() => {
    if (client === undefined) return;
    let cancelled = false;
    void (async () => {
      try {
        const v = await client.readContract({
          address: token,
          abi: launchTokenAbi,
          functionName: "taxBps",
        });
        if (!cancelled) setBps(v);
      } catch {
        // Tokens from before the tax existed have no such function. That is
        // not an error and it is not a tax — leave it unreported either way.
        if (!cancelled) setBps(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, token]);

  if (bps === null || bps === 0n) return null;

  const pct = (Number(bps) / 100).toFixed(2).replace(/\.?0+$/, "");
  const total = (Number(bps) / 100 + 1).toFixed(2).replace(/\.?0+$/, "");

  return (
    <div
      className="arch-card"
      style={{
        borderColor: "color-mix(in oklch, var(--negative) 40%, var(--border))",
        display: "flex",
        gap: "0.6rem",
        alignItems: "flex-start",
      }}
    >
      <span aria-hidden style={{ fontSize: "1.1rem", lineHeight: 1.2 }}>
        ⚠
      </span>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontWeight: 700, fontSize: "0.92rem" }}>{pct}% trade tax</div>
        <p className="arch-note" style={{ margin: "0.2rem 0 0" }}>
          This token takes {pct}% of every buy and sell and burns it. With the 1% pool fee you pay
          about {total}% per trade, and you will receive slightly less than any quote shows.
          Sending the token between wallets is untaxed. The rate was fixed at launch and cannot be
          changed.
        </p>
      </div>
    </div>
  );
}
