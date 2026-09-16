"use client";

import { useEffect, useState } from "react";
import { usePublicClient } from "wagmi";
import { getChain, type ChainKey } from "@/lib/chains";
import { poolAbi, priceUsdE18, formatPriceE18 } from "@/lib/launchpad";
import { readV4Slot0 } from "@/lib/v4";
import type { Hex } from "viem";

/**
 * Live headline price. Server-renders the initial value (passed as a preformatted
 * string — bigints don't cross the server/client boundary), then polls the pool's
 * slot0 every few seconds so the price keeps up without a page reload.
 */
export function LivePrice({
  pool,
  poolId,
  tokenIsToken0,
  initial,
  chainKey = "arc",
}: {
  readonly pool: Hex;
  /** Set for a v4 market, where the pool is an id rather than a contract. */
  readonly poolId?: Hex | undefined;
  readonly tokenIsToken0: boolean;
  readonly initial: string;
  readonly chainKey?: ChainKey;
}) {
  const chain = getChain(chainKey);
  const arc = usePublicClient({ chainId: chain.id });
  const [text, setText] = useState(initial);

  useEffect(() => {
    if (arc === undefined) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async (): Promise<void> => {
      try {
        // A v4 pool has no contract to call slot0 on: the price lives in the
        // PoolManager under the pool's id, read here through StateView. Same
        // sqrtPriceX96, same maths, different door.
        const sqrtPriceX96 =
          poolId === undefined
            ? (await arc.readContract({ address: pool, abi: poolAbi, functionName: "slot0" }))[0]
            : (await readV4Slot0(arc, poolId))?.sqrtPriceX96;
        if (sqrtPriceX96 === undefined) return;
        if (!cancelled) setText(formatPriceE18(priceUsdE18(sqrtPriceX96, tokenIsToken0, chain.quote.decimals)));
      } catch { /* transient */ }
      if (!cancelled) timer = setTimeout(() => void tick(), 3_000);
    };
    timer = setTimeout(() => void tick(), 3_000);
    return () => { cancelled = true; if (timer !== undefined) clearTimeout(timer); };
  }, [arc, pool, poolId, tokenIsToken0]);

  return <>{text}</>;
}
