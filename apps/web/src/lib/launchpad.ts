import { createPublicClient, fallback, http, type Hex, type PublicClient } from "viem";

/**
 * Launchpad chain access + exact bigint price math. No floats ever touch a
 * monetary value; the JS-Number formula in Envelope's docs is deliberately
 * not used (coding rule).
 */

export const FACTORY_ADDRESS = process.env["NEXT_PUBLIC_ARCH_LAUNCHPAD_FACTORY_ADDRESS"] as Hex | undefined;
/** Previous factory generation — tokens launched there stay listed/tradable. */
export const LEGACY_FACTORY_ADDRESS: Hex =
  (process.env["NEXT_PUBLIC_ARCH_LEGACY_FACTORY_ADDRESS"] as Hex | undefined) ??
  "0xa024664ad5d30f3c0b18b931ddb6f64a96de8ed3";
export const GRADUATION_ADDRESS = process.env["NEXT_PUBLIC_ARCH_GRADUATION_REGISTRY_ADDRESS"] as Hex | undefined;
export const DISTRIBUTOR_ADDRESS = process.env["NEXT_PUBLIC_ARCH_FEE_DISTRIBUTOR_ADDRESS"] as Hex | undefined;
export const ROUTER_ADDRESS = process.env["NEXT_PUBLIC_UNISWAP_SWAP_ROUTER_ADDRESS"] as Hex | undefined;
export const LIQUIDITY_VAULT_ADDRESS = process.env["NEXT_PUBLIC_ARCH_LIQUIDITY_VAULT_ADDRESS"] as Hex | undefined;

export const GRADUATION_UNITS = 9_000_000_000n; // 9,000 quote units (6d)
const Q192 = 2n ** 192n;

/** Tokens hidden from the launchpad UI (e.g. internal test launches). They
 *  still exist on-chain — this only removes them from our lists and pages. */
const HIDDEN_TOKENS = new Set(
  [
    "0xE7c4f3a9F20AfbCA5A238d4fA705344943Ed9B5C", // Archway — internal test launch (old factory)
    "0x6347dB930F087D99E722652921e22f3Ca545eA45", // RTCK — router-fix verification launch
    "0x54464cA71f55C59b2e944B09e24cA689A918e644", // AROS — pre-public test launch (fresh start)
    "0x10667F1aF42927cae3C4E41d95B009A1a3140bC6", // RDCK — fee-redirect verification launch
    ...(process.env["NEXT_PUBLIC_ARCH_HIDDEN_TOKENS"] ?? "").split(","),
  ]
    .map((s) => s.trim().toLowerCase())
    .filter((s) => /^0x[0-9a-f]{40}$/.test(s)),
);
export function isHidden(token: string): boolean {
  return HIDDEN_TOKENS.has(token.toLowerCase());
}

export function arcPublicClient(): PublicClient {
  return createPublicClient({
    transport: fallback([
      http(process.env["NEXT_PUBLIC_ARC_RPC_URL"] ?? "https://rpc.blockdaemon.mainnet.arc.io", { timeout: 8000 }),
      http("https://rpc.blockdaemon.mainnet.arc.io", { timeout: 8000 }),
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
          { name: "feeRecipient", type: "address" },
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

// SwapRouter02 interface — NOTE: no `deadline` field (unlike SwapRouter v1).
// The router deployed on Arc mainnet is SwapRouter02; calling it with the v1
// tuple (extra deadline) selects a nonexistent function and reverts.
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

/** Compact USD from 6-decimal units: $3,032 · $18.4K · $1.2M — display only. */
export function formatUsdCompact(units: bigint): string {
  const cents = Number(units) / 1e6; // display-only float
  if (cents >= 1e9) return `$${(cents / 1e9).toFixed(2)}B`;
  if (cents >= 1e6) return `$${(cents / 1e6).toFixed(2)}M`;
  if (cents >= 100_000) return `$${(cents / 1e3).toFixed(1)}K`;
  if (cents >= 1_000) return `$${Math.round(cents).toLocaleString("en-US")}`;
  return `$${cents.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
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

/** Server-side list cache: successive page loads reuse the same chain scan
 *  for a short window, cutting TTFB from seconds to milliseconds. The 2s+
 *  client polling keeps in-page data live; this only staggers list refreshes. */
const LIST_TTL_MS = 15_000;
let listCache: { at: number; tokens: LaunchpadToken[] } | null = null;
let listInFlight: Promise<LaunchpadToken[]> | null = null;

export async function fetchAllTokens(client: PublicClient): Promise<LaunchpadToken[]> {
  if (FACTORY_ADDRESS === undefined) return [];
  if (listCache !== null && Date.now() - listCache.at < LIST_TTL_MS) return listCache.tokens;
  if (listInFlight !== null) return listInFlight; // coalesce concurrent requests
  listInFlight = (async () => {
    // Both factory generations scanned fully in parallel; every read within a
    // generation is parallel too. Current generation lists first.
    const generations = await Promise.all(
      [FACTORY_ADDRESS as Hex, LEGACY_FACTORY_ADDRESS].map(async (factory) => {
        const count = await client
          .readContract({ address: factory, abi: factoryAbi, functionName: "allTokensLength" })
          .catch(() => 0n);
        const addresses = await Promise.all(
          Array.from({ length: Number(count) }, (_, i) =>
            client.readContract({ address: factory, abi: factoryAbi, functionName: "allTokens", args: [BigInt(i)] }),
          ),
        );
        const details = await Promise.all(
          addresses
            .filter((t) => !isHidden(t))
            .map((t) => fetchTokenFrom(client, factory, t).catch(() => null)),
        );
        return details.filter((d): d is LaunchpadToken => d !== null).reverse();
      }),
    );
    const tokens = generations.flat();
    listCache = { at: Date.now(), tokens };
    return tokens;
  })();
  try {
    return await listInFlight;
  } finally {
    listInFlight = null;
  }
}

/** Short per-token detail cache: repeat visits and back-navigation paint from
 *  memory while the client's live polling keeps the numbers current. */
const DETAIL_TTL_MS = 10_000;
const detailCache = new Map<string, { at: number; value: LaunchpadToken | null }>();

/** Look up a token on both factory generations in parallel (current wins). */
export async function fetchToken(client: PublicClient, token: Hex): Promise<LaunchpadToken | null> {
  if (FACTORY_ADDRESS === undefined) return null;
  const key = token.toLowerCase();
  const hit = detailCache.get(key);
  if (hit !== undefined && Date.now() - hit.at < DETAIL_TTL_MS) return hit.value;
  const [current, legacy] = await Promise.all([
    fetchTokenFrom(client, FACTORY_ADDRESS, token).catch(() => null),
    fetchTokenFrom(client, LEGACY_FACTORY_ADDRESS, token).catch(() => null),
  ]);
  const value = current ?? legacy;
  detailCache.set(key, { at: Date.now(), value });
  return value;
}

async function fetchTokenFrom(client: PublicClient, factory: Hex, token: Hex): Promise<LaunchpadToken | null> {
  const [launchedToken, creator, pairToken, pool, positionId] = await client.readContract({
    address: factory,
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
