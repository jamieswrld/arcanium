"use client";

import { useEffect, useState } from "react";
import { usePublicClient } from "wagmi";
import { arcTestnet } from "@/lib/bridgeClient";
import { poolAbi, priceUsdE18, formatPriceE18 } from "@/lib/launchpad";
import type { Hex } from "viem";

/**
 * Live headline price. Server-renders the initial value (passed as a preformatted
 * string — bigints don't cross the server/client boundary), then polls the pool's
 * slot0 every few seconds so the price keeps up without a page reload.
 */
export function LivePrice({
  pool,
  tokenIsToken0,
  initial,
}: {
  readonly pool: Hex;
  readonly tokenIsToken0: boolean;
  readonly initial: string;
}) {
  const arc = usePublicClient({ chainId: arcTestnet.id });
  const [text, setText] = useState(initial);

  useEffect(() => {
    if (arc === undefined) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async (): Promise<void> => {
      try {
        const slot0 = await arc.readContract({ address: pool, abi: poolAbi, functionName: "slot0" });
        if (!cancelled) setText(formatPriceE18(priceUsdE18(slot0[0], tokenIsToken0)));
      } catch { /* transient */ }
      if (!cancelled) timer = setTimeout(() => void tick(), 3_000);
    };
    timer = setTimeout(() => void tick(), 3_000);
    return () => { cancelled = true; if (timer !== undefined) clearTimeout(timer); };
  }, [arc, pool, tokenIsToken0]);

  return <>{text}</>;
}
