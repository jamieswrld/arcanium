import { createPublicClient, fallback, http, type Hex, type PublicClient } from "viem";

/**
 * Launchpad chain access + exact bigint price math. No floats ever touch a
 * monetary value; the JS-Number formula in Envelope's docs is deliberately
 * not used (coding rule).
 */

export const FACTORY_ADDRESS = process.env["NEXT_PUBLIC_ARCH_LAUNCHPAD_FACTORY_ADDRESS"] as Hex | undefined;
export const GRADUATION_ADDRESS = process.env["NEXT_PUBLIC_ARCH_GRADUATION_REGISTRY_ADDRESS"] as Hex | undefined;
export const DISTRIBUTOR_ADDRESS = process.env["NEXT_PUBLIC_ARCH_FEE_DISTRIBUTOR_ADDRESS"] as Hex | undefined;
export const ROUTER_ADDRESS = process.env["NEXT_PUBLIC_UNISWAP_SWAP_ROUTER_ADDRESS"] as Hex | undefined;

export const GRADUATION_UNITS = 9_000_000_000n; // 9,000 quote units (6d)
const Q192 = 2n ** 192n;

export function arcPublicClient(): PublicClient {
  return createPublicClient({
    transport: fallback([
      http(process.env["NEXT_PUBLIC_ARC_RPC_URL"] ?? "https://5042002.rpc.thirdweb.com"),
      http("https://arc-testnet.drpc.org"),
      http("https://rpc.testnet.arc.network"),
    ]),
  });
}

export const factoryAbi = [
  { type: "function", name: "allTokensLength", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "allTokens", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "address" }] },
  {
    type: "function",
    name: "launches",
    stateMutability: "view",
    inputs: [{ type: "address" }],
    outputs: [
      { name: "token", type: "address" },
      { name: "creator", type: "address" },
      { name: "pairToken", type: "address" },
      { name: "pool", type: "address" },
      { name: "positionId", type: "uint256" },
    ],
  },
  { type: "function", name: "launchFee", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "pairToken", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  {
    type: "function",
    name: "launch",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "name", type: "string" },
          { name: "symbol", type: "string" },
          { name: "metadataUri", type: "string" },
          { name: "pairToken", type: "address" },
          { name: "creatorBuyAmount", type: "uint256" },
          { name: "minTokensOut", type: "uint256" },
          { name: "deadline", type: "uint256" },
        ],
      },
    ],
    outputs: [
      { name: "token", type: "address" },
      { name: "pool", type: "address" },
      { name: "positionId", type: "uint256" },
    ],
  },
] as const;

export const poolAbi = [
  {
    type: "function",
    name: "slot0",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "sqrtPriceX96", type: "uint160" },
      { name: "tick", type: "int24" },
      { name: "observationIndex", type: "uint16" },
      { name: "observationCardinality", type: "uint16" },
      { name: "observationCardinalityNext", type: "uint16" },
      { name: "feeProtocol", type: "uint8" },
      { name: "unlocked", type: "bool" },
    ],
  },
] as const;

export const routerAbi = [
  {
    type: "function",
    name: "exactInputSingle",
    stateMutability: "payable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "fee", type: "uint24" },
          { name: "recipient", type: "address" },
          { name: "deadline", type: "uint256" },
          { name: "amountIn", type: "uint256" },
          { name: "amountOutMinimum", type: "uint256" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
      },
    ],
    outputs: [{ name: "amountOut", type: "uint256" }],
  },
] as const;

export const graduationAbi = [
  { type: "function", name: "graduated", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "checkGraduation", stateMutability: "nonpayable", inputs: [{ type: "address" }], outputs: [] },
] as const;

export const distributorAbi = [
  { type: "function", name: "distribute", stateMutability: "nonpayable", inputs: [{ type: "address" }], outputs: [] },
] as const;

export const erc20MetaAbi = [
  { type: "function", name: "name", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

/**
 * USD price per whole token, scaled 1e18, from sqrtPriceX96 with a 6-decimal
 * quote and 18-decimal token. Exact bigint math for both orderings.
 */
export function priceUsdE18(sqrtPriceX96: bigint, tokenIsToken0: boolean): bigint {
  const numerator = sqrtPriceX96 * sqrtPriceX96;
  if (tokenIsToken0) {
    // P(quoteRaw/tokenRaw) = sqrtP²/2¹⁹²; USD/token ×1e18 = P × 1e30.
    return (numerator * 10n ** 30n) / Q192;
  }
  // token is token1: USD/token ×1e18 = 1e30 × 2¹⁹² / sqrtP².
  return (10n ** 30n * Q192) / numerator;
}

/** Market cap in 6-decimal USD units for the fixed 1e9-token supply. */
export function marketCapUsdUnits(priceE18: bigint): bigint {
  // mcap USD = price × 1e9; in 6d units: price_e18 × 1e9 × 1e6 / 1e18.
  return (priceE18 * 10n ** 15n) / 10n ** 18n;
}

/** Render an e18-scaled USD price with sensible sub-cent precision. */
export function formatPriceE18(priceE18: bigint): string {
  if (priceE18 === 0n) return "$0";
  const whole = priceE18 / 10n ** 18n;
  if (whole > 0n) {
    const cents = (priceE18 % 10n ** 18n) / 10n ** 16n;
    return `$${whole.toLocaleString("en-US")}.${cents.toString().padStart(2, "0")}`;
  }
  // Sub-dollar: show 3 significant figures.
  const s = priceE18.toString().padStart(19, "0");
  const frac = s.slice(-18);
  const firstSig = frac.search(/[1-9]/);
  const digits = frac.slice(firstSig, firstSig + 3);
  return `$0.${"0".repeat(firstSig)}${digits}`;
}

export interface LaunchpadToken {
  readonly token: Hex;
  readonly name: string;
  readonly symbol: string;
  readonly creator: Hex;
  readonly pairToken: Hex;
  readonly pool: Hex;
  readonly positionId: bigint;
  readonly priceE18: bigint;
  readonly marketCapUnits: bigint;
  readonly quoteBalance: bigint;
  readonly graduated: boolean;
}

export async function fetchAllTokens(client: PublicClient): Promise<LaunchpadToken[]> {
  if (FACTORY_ADDRESS === undefined) return [];
  const count = await client.readContract({
    address: FACTORY_ADDRESS,
    abi: factoryAbi,
    functionName: "allTokensLength",
  });
  const tokens: LaunchpadToken[] = [];
  for (let i = 0n; i < count; i++) {
    const token = await client.readContract({
      address: FACTORY_ADDRESS,
      abi: factoryAbi,
      functionName: "allTokens",
      args: [i],
    });
    const detail = await fetchToken(client, token);
    if (detail !== null) tokens.push(detail);
  }
  return tokens.reverse(); // newest first
}

export async function fetchToken(client: PublicClient, token: Hex): Promise<LaunchpadToken | null> {
  if (FACTORY_ADDRESS === undefined) return null;
  const [launchedToken, creator, pairToken, pool, positionId] = await client.readContract({
    address: FACTORY_ADDRESS,
    abi: factoryAbi,
    functionName: "launches",
    args: [token],
  });
  if (launchedToken === "0x0000000000000000000000000000000000000000") return null;
  const [name, symbol, slot0, quoteBalance, graduated] = await Promise.all([
    client.readContract({ address: token, abi: erc20MetaAbi, functionName: "name" }),
    client.readContract({ address: token, abi: erc20MetaAbi, functionName: "symbol" }),
    client.readContract({ address: pool, abi: poolAbi, functionName: "slot0" }),
    client.readContract({ address: pairToken, abi: erc20MetaAbi, functionName: "balanceOf", args: [pool] }),
    GRADUATION_ADDRESS !== undefined
      ? client.readContract({ address: GRADUATION_ADDRESS, abi: graduationAbi, functionName: "graduated", args: [token] })
      : Promise.resolve(false),
  ]);
  const tokenIsToken0 = token.toLowerCase() < pairToken.toLowerCase();
  const priceE18 = priceUsdE18(slot0[0], tokenIsToken0);
  return {
    token,
    name,
    symbol,
    creator,
    pairToken,
    pool,
    positionId,
    priceE18,
    marketCapUnits: marketCapUsdUnits(priceE18),
    quoteBalance,
    graduated,
  };
}
