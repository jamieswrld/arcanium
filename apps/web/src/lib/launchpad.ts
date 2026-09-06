import { createPublicClient, type Hex, type PublicClient } from "viem";
import { arcChain, arcTransport } from "@/lib/arcRpc";

/**
 * Launchpad chain access + exact bigint price math. No floats ever touch a
 * monetary value; the JS-Number formula in Envelope's docs is deliberately
 * not used (coding rule).
 */

export const FACTORY_ADDRESS = process.env["NEXT_PUBLIC_ARCH_LAUNCHPAD_FACTORY_ADDRESS"] as Hex | undefined;
/** Every factory generation, newest first. Tokens are NEVER dropped when the
 *  factory is upgraded — each generation stays listed, tradable, and
 *  collectable forever. Append new generations to the front. */
export const FACTORY_GENERATIONS: readonly Hex[] = [
  "0x8e5732B520a318251a702a680AA7F123fb92AF52", // v4 — launch modes
  "0xE2aA88806872C2a02A4ab439584d457002983600", // v3 — fee recipient
  "0xA024664AD5d30F3c0b18b931DdB6f64A96DE8ED3", // v2 — SwapRouter02 fix
  "0x1d65ab4cDCDdA6f38A9c93a24EF64bE8905e19d5", // v1 — original
];
/** Kept for callers that want the immediately previous generation. */
export const LEGACY_FACTORY_ADDRESS: Hex =
  (process.env["NEXT_PUBLIC_ARCH_LEGACY_FACTORY_ADDRESS"] as Hex | undefined) ??
  "0xE2aA88806872C2a02A4ab439584d457002983600";
export const GRADUATION_ADDRESS = process.env["NEXT_PUBLIC_ARCH_GRADUATION_REGISTRY_ADDRESS"] as Hex | undefined;
export const DISTRIBUTOR_ADDRESS = process.env["NEXT_PUBLIC_ARCH_FEE_DISTRIBUTOR_ADDRESS"] as Hex | undefined;
export const ROUTER_ADDRESS = process.env["NEXT_PUBLIC_UNISWAP_SWAP_ROUTER_ADDRESS"] as Hex | undefined;
/** Mode distributor (v4): routes creator fees by launch mode. */
export const MODE_DISTRIBUTOR_ADDRESS =
  (process.env["NEXT_PUBLIC_ARCH_MODE_DISTRIBUTOR_ADDRESS"] as Hex | undefined) ??
  "0x7c148B6a581E32CcB6ffF7Bd59AF4250d5ec1eBc";

/** Launch modes, fixed at launch and immutable. */
export const LAUNCH_MODES = [
  { id: 0, key: "standard", label: "Standard", blurb: "Creator fees are paid to your wallet." },
  { id: 1, key: "divium", label: "Divium", blurb: "Creator fees are paid out to everyone holding the token, in USDC." },
  { id: 2, key: "arcane", label: "Arcane Mode", blurb: "Creator fees buy the token on the market and burn it forever." },
] as const;

export const modeDistributorAbi = [
  { type: "function", name: "modeOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint8" }] },
  { type: "function", name: "modeSet", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "claimable", stateMutability: "view", inputs: [{ type: "address" }, { type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "claimRewards", stateMutability: "nonpayable", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "distribute", stateMutability: "nonpayable", inputs: [{ type: "address" }], outputs: [] },
  { type: "function", name: "creatorShareBps", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;

export const LIQUIDITY_VAULT_ADDRESS = process.env["NEXT_PUBLIC_ARCH_LIQUIDITY_VAULT_ADDRESS"] as Hex | undefined;

export const GRADUATION_UNITS = 9_000_000_000n; // 9,000 quote units (6d)
const Q192 = 2n ** 192n;

/** Launches hidden from the Arcanium UI.
 *
 *  Empty by design: every launch, on every factory generation, stays listed.
 *
 *  Hiding is presentation only — a token here still exists on-chain, still
 *  trades, still holds its locked liquidity and still pays its fees. Nothing is
 *  ever deleted. Add an address below (or to NEXT_PUBLIC_ARCH_HIDDEN_TOKENS) to
 *  drop it from listings, and remove it to bring it straight back.
 *
 *  The list lives in source as well as env because .env.local is gitignored and
 *  never reaches production, so an env-only denylist silently does nothing once
 *  deployed.
 */
const HIDDEN_DEFAULTS: readonly string[] = [];

const HIDDEN_TOKENS = new Set(
  [...HIDDEN_DEFAULTS, ...(process.env["NEXT_PUBLIC_ARCH_HIDDEN_TOKENS"] ?? "").split(",")]
    .map((v) => v.trim().toLowerCase())
    .filter((v) => /^0x[0-9a-f]{40}$/.test(v)),
);
export function isHidden(token: string): boolean {
  return HIDDEN_TOKENS.has(token.toLowerCase());
}

/** True when the last list attempt failed to reach any RPC (as opposed to
 *  there genuinely being no tokens). Lets the UI tell the truth. */
export let arcUnreachable = false;

export function arcPublicClient(): PublicClient {
  // Batched through Multicall3: listing the pad is ~4 reads per token across
  // four factory generations, and the public RPC drops a large fraction of a
  // burst that size. Batching turns those into a handful of requests.
  return createPublicClient({
    chain: arcChain,
    transport: arcTransport(),
    batch: { multicall: { wait: 12, batchSize: 512 } },
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
          { name: "taxBps", type: "uint256" },
          { name: "mode", type: "uint8" },
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

/** v4 tokens name their own distributor — read it from the token so mode and
 *  claims always target the contract that token was launched against. */
export const launchTokenAbi = [
  { type: "function", name: "taxRecipient", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "rewardsEnabled", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
] as const;

export const erc20MetaAbi = [
  { type: "function", name: "name", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

/**
 * USD price per whole token, scaled 1e18, from sqrtPriceX96 with an
 * 18-decimal token. Exact bigint math for both orderings.
 *
 * The scale factor is 10^(36 - quoteDecimals): 1e30 for Arc's 6-decimal USDC.
 * Parameterised rather than hardcoded so a quote asset with different decimals
 * can never be silently mispriced by a factor of 1e12.
 */
export function priceUsdE18(
  sqrtPriceX96: bigint,
  tokenIsToken0: boolean,
  quoteDecimals = 6,
): bigint {
  const numerator = sqrtPriceX96 * sqrtPriceX96;
  const scale = 10n ** BigInt(36 - quoteDecimals);
  if (tokenIsToken0) {
    // P(quoteRaw/tokenRaw) = sqrtP²/2¹⁹²; USD/token ×1e18 = P × scale.
    return (numerator * scale) / Q192;
  }
  // token is token1: USD/token ×1e18 = scale × 2¹⁹² / sqrtP².
  return (scale * Q192) / numerator;
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
  /** 0 standard · 1 divium · 2 arcane · null when not a mode-aware launch. */
  readonly mode: number | null;
}

/** Mode lookups are cached separately and never block a listing: a token's
 *  mode is immutable, so once known it is known forever. */
const MODE_TTL_MS = 120_000;
const modeCache = new Map<string, { at: number; mode: number | null }>();

async function fetchModes(client: PublicClient, tokens: readonly Hex[]): Promise<Map<string, number | null>> {
  const out = new Map<string, number | null>();
  const misses: Hex[] = [];
  for (const t of tokens) {
    const hit = modeCache.get(t.toLowerCase());
    if (hit !== undefined && (hit.mode !== null || Date.now() - hit.at < MODE_TTL_MS)) out.set(t.toLowerCase(), hit.mode);
    else misses.push(t);
  }
  if (misses.length === 0) return out;
  await Promise.all(
    misses.map(async (t) => {
      const mode = await (async (): Promise<number | null> => {
        const isSet = await client
          .readContract({ address: MODE_DISTRIBUTOR_ADDRESS, abi: modeDistributorAbi, functionName: "modeSet", args: [t] })
          .catch(() => false);
        if (!isSet) return null;
        const m = await client
          .readContract({ address: MODE_DISTRIBUTOR_ADDRESS, abi: modeDistributorAbi, functionName: "modeOf", args: [t] })
          .catch(() => null);
        return m === null ? null : Number(m);
      })();
      modeCache.set(t.toLowerCase(), { at: Date.now(), mode });
      out.set(t.toLowerCase(), mode);
    }),
  );
  return out;
}

/** Server-side list cache: successive page loads reuse the same chain scan
 *  for a short window, cutting TTFB from seconds to milliseconds. The 2s+
 *  client polling keeps in-page data live; this only staggers list refreshes. */
const LIST_TTL_MS = 15_000;
let listCache: { at: number; tokens: LaunchpadToken[] } | null = null;
let listInFlight: Promise<LaunchpadToken[]> | null = null;

export async function fetchAllTokens(client: PublicClient): Promise<LaunchpadToken[]> {
  // Gate on whether we know of any factory at all — never on the optional env
  // override. This guard used to read `FACTORY_ADDRESS === undefined`, so with
  // that variable unset the scan returned an empty list instantly and the pad
  // rendered empty while four perfectly good factory generations sat in
  // FACTORY_GENERATIONS below. It only went unnoticed because Arc was gated.
  if (FACTORY_GENERATIONS.length === 0 && FACTORY_ADDRESS === undefined) return [];
  if (listCache !== null && Date.now() - listCache.at < LIST_TTL_MS) return listCache.tokens;
  if (listInFlight !== null) return listInFlight; // coalesce concurrent requests
  listInFlight = (async () => {
    // Both factory generations scanned fully in parallel; every read within a
    // generation is parallel too. Current generation lists first.
    const all = FACTORY_ADDRESS !== undefined && !FACTORY_GENERATIONS.includes(FACTORY_ADDRESS)
      ? [FACTORY_ADDRESS as Hex, ...FACTORY_GENERATIONS]
      : FACTORY_GENERATIONS;
    const generations = await Promise.all(
      all.map(async (factory) => {
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
    const reachable = generations.some((g) => g.length > 0) || (await client.getBlockNumber().then(() => true).catch(() => false));
    arcUnreachable = !reachable;
    const flat = generations.flat();
    const modes = await fetchModes(client, flat.map((t) => t.token)).catch(() => new Map<string, number | null>());
    const tokens = flat.map((t) => ({ ...t, mode: modes.get(t.token.toLowerCase()) ?? null }));
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
  if (FACTORY_GENERATIONS.length === 0 && FACTORY_ADDRESS === undefined) return null;
  const key = token.toLowerCase();
  const hit = detailCache.get(key);
  if (hit !== undefined && Date.now() - hit.at < DETAIL_TTL_MS) return hit.value;
  const found = await Promise.all(
    FACTORY_GENERATIONS.map((f) => fetchTokenFrom(client, f, token).catch(() => null)),
  );
  const base = found.find((v) => v !== null) ?? null;
  const value =
    base === null
      ? null
      : { ...base, mode: (await fetchModes(client, [base.token]).catch(() => new Map())).get(base.token.toLowerCase()) ?? null };
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
    mode: null,
  };
}
