import { encodeAbiParameters, encodePacked, keccak256, type Hex, type PublicClient } from "viem";
import { getChain } from "@/lib/chains";

/**
 * Trading a Uniswap v4 pool.
 *
 * Nothing here has a v3 equivalent to copy, because v4 moved every part of the
 * interaction:
 *
 *   · A pool has no address. It is a PoolKey — the two currencies, the fee, the
 *     tick spacing and the hook — hashed into a 32-byte id, and the id is what
 *     every read is keyed on.
 *   · Quoting is not a view call. The Quoter performs the swap for real and
 *     reverts to unwind it, which means it has to be simulated rather than
 *     read, and a stale simulation is the only way to get a stale quote.
 *   · Swapping goes through the UniversalRouter as an encoded action list, and
 *     the router takes the input through Permit2 rather than a direct
 *     allowance. That is one extra approval the first time, and none after.
 *
 * The currencies in a PoolKey must be sorted. Getting that backwards produces a
 * different id, which silently addresses a pool that does not exist rather than
 * failing, so it is done in one place here and nowhere else.
 */

export interface PoolKey {
  readonly currency0: Hex;
  readonly currency1: Hex;
  readonly fee: number;
  readonly tickSpacing: number;
  readonly hooks: Hex;
}

const POOL_KEY_ABI = [
  {
    type: "tuple",
    components: [
      { name: "currency0", type: "address" },
      { name: "currency1", type: "address" },
      { name: "fee", type: "uint24" },
      { name: "tickSpacing", type: "int24" },
      { name: "hooks", type: "address" },
    ],
  },
] as const;

/** UniversalRouter's V4_SWAP command. */
const V4_SWAP = 0x10;

/** v4-periphery action ids. */
const SWAP_EXACT_IN_SINGLE = 0x06;
const SETTLE_ALL = 0x0c;
const TAKE_ALL = 0x0f;

export function poolKeyFor(token: Hex, quote: Hex, hook: Hex, fee: number, tickSpacing: number): PoolKey {
  const tokenIs0 = token.toLowerCase() < quote.toLowerCase();
  return {
    currency0: tokenIs0 ? token : quote,
    currency1: tokenIs0 ? quote : token,
    fee,
    tickSpacing,
    hooks: hook,
  };
}

/** The pool's identity: keccak256 of the abi-encoded key, as v4-core computes it. */
export function poolIdFor(key: PoolKey): Hex {
  return keccak256(
    encodeAbiParameters(POOL_KEY_ABI, [
      {
        currency0: key.currency0,
        currency1: key.currency1,
        fee: key.fee,
        tickSpacing: key.tickSpacing,
        hooks: key.hooks,
      },
    ]),
  );
}

/** True when buying the token means swapping currency0 for currency1. */
export function buyIsZeroForOne(token: Hex, quote: Hex): boolean {
  return quote.toLowerCase() < token.toLowerCase();
}

export const quoterAbi = [
  {
    type: "function",
    name: "quoteExactInputSingle",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          {
            name: "poolKey",
            type: "tuple",
            components: [
              { name: "currency0", type: "address" },
              { name: "currency1", type: "address" },
              { name: "fee", type: "uint24" },
              { name: "tickSpacing", type: "int24" },
              { name: "hooks", type: "address" },
            ],
          },
          { name: "zeroForOne", type: "bool" },
          { name: "exactAmount", type: "uint128" },
          { name: "hookData", type: "bytes" },
        ],
      },
    ],
    outputs: [
      { name: "amountOut", type: "uint256" },
      { name: "gasEstimate", type: "uint256" },
    ],
  },
] as const;

export const stateViewAbi = [
  {
    type: "function",
    name: "getSlot0",
    stateMutability: "view",
    inputs: [{ name: "poolId", type: "bytes32" }],
    outputs: [
      { name: "sqrtPriceX96", type: "uint160" },
      { name: "tick", type: "int24" },
      { name: "protocolFee", type: "uint24" },
      { name: "lpFee", type: "uint24" },
    ],
  },
  {
    type: "function",
    name: "getLiquidity",
    stateMutability: "view",
    inputs: [{ name: "poolId", type: "bytes32" }],
    outputs: [{ name: "liquidity", type: "uint128" }],
  },
] as const;

export const universalRouterAbi = [
  {
    type: "function",
    name: "execute",
    stateMutability: "payable",
    inputs: [
      { name: "commands", type: "bytes" },
      { name: "inputs", type: "bytes[]" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

export const permit2Abi = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token", type: "address" },
      { name: "spender", type: "address" },
      { name: "amount", type: "uint160" },
      { name: "expiration", type: "uint48" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "user", type: "address" },
      { name: "token", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [
      { name: "amount", type: "uint160" },
      { name: "expiration", type: "uint48" },
      { name: "nonce", type: "uint48" },
    ],
  },
] as const;

export const PERMIT2: Hex = "0x000000000022D473030F116dDEE9F6B43aC78BA3";

/**
 * What a swap would return, quoted against current state.
 *
 * Simulated rather than read: the Quoter executes the swap and reverts to undo
 * it, so there is no view function to call. Returns null when the pool cannot
 * answer — which is a different thing from quoting zero, and the caller must
 * not round it to one.
 */
export async function quoteV4(
  client: PublicClient,
  key: PoolKey,
  zeroForOne: boolean,
  amountIn: bigint,
): Promise<bigint | null> {
  const chain = getChain("arc");
  const quoter = chain.v4?.quoter;
  if (quoter === undefined || amountIn <= 0n) return null;
  try {
    const { result } = await client.simulateContract({
      address: quoter,
      abi: quoterAbi,
      functionName: "quoteExactInputSingle",
      args: [{ poolKey: key, zeroForOne, exactAmount: amountIn, hookData: "0x" }],
    });
    return result[0];
  } catch {
    return null;
  }
}

/** Current price and liquidity, or null when the pool cannot be read. */
export async function readV4Slot0(
  client: PublicClient,
  poolId: Hex,
): Promise<{ sqrtPriceX96: bigint; tick: number; liquidity: bigint } | null> {
  const chain = getChain("arc");
  const stateView = chain.v4?.stateView;
  if (stateView === undefined) return null;
  try {
    const [slot0, liquidity] = await Promise.all([
      client.readContract({ address: stateView, abi: stateViewAbi, functionName: "getSlot0", args: [poolId] }),
      client.readContract({ address: stateView, abi: stateViewAbi, functionName: "getLiquidity", args: [poolId] }),
    ]);
    return { sqrtPriceX96: slot0[0], tick: slot0[1], liquidity };
  } catch {
    return null;
  }
}

/**
 * The calldata for a single-pool exact-input swap.
 *
 * The router takes an action list rather than a function call: perform the
 * swap, pay what is owed, collect what is due. SETTLE_ALL and TAKE_ALL are
 * used rather than their bounded variants because a single-pool exact-input
 * swap owes exactly one currency and is owed exactly one, and naming the
 * amounts twice only creates a way for them to disagree.
 *
 * `amountOutMinimum` is the caller's slippage bound and is enforced by the
 * router, not by us — passing zero would accept any price at all.
 */
export function encodeV4Swap(
  key: PoolKey,
  zeroForOne: boolean,
  amountIn: bigint,
  amountOutMinimum: bigint,
): { commands: Hex; inputs: readonly Hex[] } {
  const currencyIn = zeroForOne ? key.currency0 : key.currency1;
  const currencyOut = zeroForOne ? key.currency1 : key.currency0;

  const actions = encodePacked(
    ["uint8", "uint8", "uint8"],
    [SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL],
  );

  const swapParams = encodeAbiParameters(
    [
      {
        type: "tuple",
        components: [
          {
            name: "poolKey",
            type: "tuple",
            components: [
              { name: "currency0", type: "address" },
              { name: "currency1", type: "address" },
              { name: "fee", type: "uint24" },
              { name: "tickSpacing", type: "int24" },
              { name: "hooks", type: "address" },
            ],
          },
          { name: "zeroForOne", type: "bool" },
          { name: "amountIn", type: "uint128" },
          { name: "amountOutMinimum", type: "uint128" },
          // Present in this periphery version. Zero means no per-hop price
          // bound; the slippage check above is what actually protects the
          // trade, and inventing a second limit here would only reject swaps
          // the caller already accepted.
          { name: "minHopPriceX36", type: "uint256" },
          { name: "hookData", type: "bytes" },
        ],
      },
    ],
    [
      {
        poolKey: key,
        zeroForOne,
        amountIn,
        amountOutMinimum,
        minHopPriceX36: 0n,
        hookData: "0x" as Hex,
      },
    ],
  );

  const settle = encodeAbiParameters(
    [{ type: "address" }, { type: "uint256" }],
    [currencyIn, amountIn],
  );
  const take = encodeAbiParameters(
    [{ type: "address" }, { type: "uint256" }],
    [currencyOut, amountOutMinimum],
  );

  const input = encodeAbiParameters(
    [{ type: "bytes" }, { type: "bytes[]" }],
    [actions, [swapParams, settle, take]],
  );

  return {
    commands: encodePacked(["uint8"], [V4_SWAP]),
    inputs: [input],
  };
}
