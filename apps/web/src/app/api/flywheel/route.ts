import { NextResponse } from "next/server";
import { ARC_BUYBACK, ARC_USDC } from "@arch/chain-config";
import { arcPublicClient } from "@/lib/launchpad";

/**
 * What the flywheel has actually done.
 *
 * Read straight off the buyback contract rather than from the indexer. The
 * contract keeps running totals for exactly this reason: Arc's public RPCs
 * prune logs after a few days, so a figure reconstructed from BoughtAndBurned
 * events would quietly start shrinking as history fell off the end. A number
 * that goes down when nothing was un-burned is worse than no number.
 *
 * `burnedTotal` is the tokens this contract has bought and destroyed. It is
 * deliberately not the same as the launch token's whole burn count — the
 * supply at 0xdead also includes the token side of every trading fee and the
 * launch's own rounding dust, neither of which the flywheel did. Conflating
 * them would let the page credit the flywheel with burns it had no part in.
 */

export const dynamic = "force-dynamic";
export const revalidate = 0;

const buybackAbi = [
  { type: "function", name: "totalSpent", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "totalBurned", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "burnCount", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "pending", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;

const erc20 = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

const CORS = {
  "access-control-allow-origin": "*",
  "cache-control": "public, s-maxage=30, stale-while-revalidate=120",
} as const;

export async function GET(): Promise<NextResponse> {
  const client = arcPublicClient();

  const read = <T,>(fn: string): Promise<T | null> =>
    client
      .readContract({ address: ARC_BUYBACK, abi: buybackAbi, functionName: fn as never })
      .then((v) => v as T)
      .catch(() => null);

  const [spent, burned, count, pending, held] = await Promise.all([
    read<bigint>("totalSpent"),
    read<bigint>("totalBurned"),
    read<bigint>("burnCount"),
    read<bigint>("pending"),
    client
      .readContract({ address: ARC_USDC, abi: erc20, functionName: "balanceOf", args: [ARC_BUYBACK] })
      .catch(() => null),
  ]);

  // Null means the chain could not be read, which is a different claim from
  // zero and must not be rounded into one — a flywheel reporting "0 burned"
  // during an outage would read as broken rather than unreachable.
  if (spent === null || burned === null || count === null) {
    return NextResponse.json(
      { error: { code: "upstream_unavailable", message: "Could not read the buyback contract." } },
      { status: 503, headers: CORS },
    );
  }

  return NextResponse.json(
    {
      data: {
        contract: ARC_BUYBACK,
        spentUsd: { units: spent.toString(), decimals: 6 },
        burnedTokens: { units: burned.toString(), decimals: 18 },
        burns: Number(count),
        waiting: { units: (pending ?? held ?? 0n).toString(), decimals: 6 },
      },
      meta: { source: "chain", note: "Totals are the flywheel's own, not the token's whole burn." },
    },
    { headers: CORS },
  );
}
