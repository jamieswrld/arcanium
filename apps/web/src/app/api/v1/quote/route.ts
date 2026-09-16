import type { NextResponse } from "next/server";
import type { Hex } from "viem";
import { arcPublicClient, fetchToken, routerAbi } from "@/lib/launchpad";
import { indexedToken } from "@/lib/indexed";
import { getChain } from "@/lib/chains";
import { fail, handle, ok, parseAddress, parseEnum, preflight } from "@/lib/apiV1";

/**
 * GET /api/v1/quote
 *
 *   ?token=0x…            the market
 *   ?side=buy|sell        buy spends the pair asset, sell spends the token
 *   ?amount=<base units>  integer, in the input asset's own decimals
 *   ?slippageBps=0..5000  default 100 (1%)
 *
 * The quote is produced by simulating the exact swap the caller would send,
 * against live pool state — the same call the Arcanium front end makes. It is
 * not an approximation from a formula, so what this returns is what execution
 * gives at that block.
 *
 * A quote is only valid for the state it was computed against. It carries the
 * block number it was taken at; treat it as stale once the chain has moved and
 * always send a real `amountOutMinimum`.
 */

export const dynamic = "force-dynamic";

const SIDES = ["buy", "sell"] as const;

export function OPTIONS(): NextResponse {
  return preflight();
}

/** A zero-ish address is fine as the simulated recipient: the simulation never
 *  executes, and the router does not gate on recipient. */
const SIMULATED_TRADER = "0x000000000000000000000000000000000000dEaD" as Hex;

export async function GET(request: Request): Promise<NextResponse> {
  return handle(request, 60, async () => {
    const url = new URL(request.url);
    const token = parseAddress(url.searchParams.get("token"));
    if (token === null) {
      return fail("invalid_address", "`token` must be a 0x-prefixed 20-byte address.");
    }

    const side = parseEnum(url.searchParams.get("side"), SIDES, "buy");

    const amountRaw = (url.searchParams.get("amount") ?? "").trim();
    if (!/^\d+$/.test(amountRaw) || amountRaw === "0") {
      return fail(
        "invalid_parameter",
        "`amount` must be a positive integer in the input asset's base units.",
        { received: amountRaw, hint: side === "buy" ? "USDC has 6 decimals" : "the token has 18 decimals" },
      );
    }
    const amountIn = BigInt(amountRaw);

    const slipRaw = url.searchParams.get("slippageBps");
    const slippageBps =
      slipRaw === null || !/^\d+$/.test(slipRaw) ? 100n : BigInt(Math.min(Number(slipRaw), 5000));

    const chain = getChain("arc");
    const market =
      (await indexedToken(token).catch(() => null)) ??
      (await fetchToken(arcPublicClient(), token as Hex).catch(() => null));
    if (market === null) {
      return fail("not_found", "No Arcanium market for that address.");
    }

    const tokenIn = side === "buy" ? market.pairToken : market.token;
    const tokenOut = side === "buy" ? market.token : market.pairToken;

    const client = arcPublicClient();
    let amountOut: bigint;
    let blockNumber: bigint;
    try {
      const [sim, block] = await Promise.all([
        client.simulateContract({
          address: chain.uniswap.swapRouter,
          abi: routerAbi,
          functionName: "exactInputSingle",
          account: SIMULATED_TRADER,
          args: [
            {
              tokenIn,
              tokenOut,
              fee: chain.poolFee,
              recipient: SIMULATED_TRADER,
              amountIn,
              amountOutMinimum: 0n,
              sqrtPriceLimitX96: 0n,
            },
          ],
        }),
        client.getBlockNumber(),
      ]);
      amountOut = sim.result;
      blockNumber = block;
    } catch {
      // The usual cause is an amount larger than the pool can fill.
      return fail(
        "upstream_unavailable",
        "Could not quote that trade. The amount may exceed available liquidity.",
      );
    }

    const minimumReceived = amountOut - (amountOut * slippageBps) / 10_000n;

    // Price impact: execution price against the pool's current spot, both as
    // USD per whole token scaled 1e18, computed in bigint throughout.
    const qd = BigInt(chain.quote.decimals);
    const toE18 = 10n ** (18n - qd); // quote base units -> 1e18 USD
    const execPriceE18 =
      side === "buy"
        ? amountOut === 0n
          ? 0n
          : (amountIn * toE18 * 10n ** 18n) / amountOut
        : amountIn === 0n
          ? 0n
          : (amountOut * toE18 * 10n ** 18n) / amountIn;

    const spot = market.priceE18;
    const impactPct =
      spot === 0n || execPriceE18 === 0n
        ? null
        : Number(((execPriceE18 - spot) * 10_000n) / spot) / 100;

    return ok(
      {
        market: market.token,
        side,
        in: {
          address: tokenIn,
          units: amountIn.toString(),
          decimals: side === "buy" ? chain.quote.decimals : 18,
          symbol: side === "buy" ? chain.quote.symbol : market.symbol,
        },
        out: {
          address: tokenOut,
          units: amountOut.toString(),
          decimals: side === "buy" ? 18 : chain.quote.decimals,
          symbol: side === "buy" ? market.symbol : chain.quote.symbol,
        },
        minimumReceived: { units: minimumReceived.toString(), decimals: side === "buy" ? 18 : chain.quote.decimals },
        slippageBps: Number(slippageBps),
        executionPrice: { units: execPriceE18.toString(), decimals: 18 },
        spotPrice: { units: spot.toString(), decimals: 18 },
        priceImpactPct: impactPct,
        poolFeeBps: chain.poolFee / 100,
        route: { router: chain.uniswap.swapRouter, pool: market.pool, feeTier: chain.poolFee },
      },
      {
        chainId: chain.id,
        blockNumber: blockNumber.toString(),
        note: "Quoted by simulating the swap against live pool state. Re-quote before signing if the chain has moved.",
      },
      0, // never cache a quote
    );
  });
}
