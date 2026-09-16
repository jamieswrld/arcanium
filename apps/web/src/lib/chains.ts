import type { Hex } from "viem";

/**
 * Arc — the chain Arcanium launches on.
 *
 * A launch is: fixed 1B supply, a real Uniswap v3 pool from block one at a
 * ~$3,000 cap, the whole supply locked in a single-sided position, a 90/10
 * protocol/creator fee split, and the Divium / Arcane fee modes.
 *
 * The registry shape is kept (rather than inlining constants everywhere)
 * because it keeps addresses, RPCs and the quote asset in exactly one place.
 *
 * NOTE ON ENV VARS: Next.js only inlines `process.env.X` when X is a *static
 * literal*. `process.env[someVariable]` is silently undefined in the browser —
 * that bug once made every address disappear client-side. So each chain spells
 * its overrides out longhand. Do not refactor these into a loop.
 */

export type ChainKey = "arc";

export interface QuoteAsset {
  readonly address: Hex;
  readonly symbol: string;
  readonly decimals: number;
  /** Human label for the asset in copy, e.g. "native USDC". */
  readonly label: string;
}

export interface UniswapAddresses {
  readonly factory: Hex;
  readonly positionManager: Hex;
  readonly swapRouter: Hex;
  readonly quoter?: Hex | undefined;
}

export interface LaunchChain {
  readonly key: ChainKey;
  readonly id: number;
  readonly name: string;
  readonly shortName: string;
  readonly nativeCurrency: { readonly name: string; readonly symbol: string; readonly decimals: number };
  readonly rpcUrls: readonly string[];
  readonly explorer: { readonly name: string; readonly url: string };
  readonly quote: QuoteAsset;
  readonly uniswap: UniswapAddresses;
  /** Pool fee tier used for every launch. tickSpacing 200 on Arc. */
  readonly poolFee: number;
  /**
   * Every factory generation, newest first. Tokens are NEVER dropped when the
   * factory is upgraded — each generation stays listed, tradable and
   * collectable forever. Append new generations to the front.
   */
  readonly factories: readonly Hex[];
  readonly liquidityVault?: Hex | undefined;
  readonly modeDistributor?: Hex | undefined;
  /** Quote units that mark a token graduated (9,000 of the quote asset). */
  readonly graduationUnits: bigint;
  /** Native-gas floor for a full launch, so the form can fail fast with a clear
   *  message instead of a cryptic wallet error. A launch is ~9M gas. */
  readonly launchGasFloor: bigint;
  /** False until our stack is deployed — the UI shows it as coming soon. */
  readonly live: boolean;
  /** Brand accent for chain chips/badges. */
  readonly accent: string;
}

function envList(raw: string | undefined): Hex[] {
  if (raw === undefined || raw.trim() === "") return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s): s is Hex => /^0x[0-9a-fA-F]{40}$/.test(s));
}

function envUrls(raw: string | undefined): string[] {
  if (raw === undefined || raw.trim() === "") return [];
  return raw.split(",").map((s) => s.trim()).filter((s) => /^https?:\/\//.test(s));
}

/**
 * Factory generations, newest first, with duplicates removed. An env override
 * naming an address that is also a built-in default must not list that factory
 * twice — every token on it would be read (and shown) twice.
 */
function factoryList(envValue: string | undefined, defaults: readonly Hex[]): Hex[] {
  const seen = new Set<string>();
  return [...envList(envValue), ...defaults].filter((a) => {
    const k = a.toLowerCase();
    return seen.has(k) ? false : (seen.add(k), true);
  });
}

function addr(raw: string | undefined): Hex | undefined {
  return raw !== undefined && /^0x[0-9a-fA-F]{40}$/.test(raw.trim()) ? (raw.trim() as Hex) : undefined;
}

/** 9,000 units of the quote asset, at that asset's decimals. */
function graduationUnits(decimals: number): bigint {
  return 9_000n * 10n ** BigInt(decimals);
}

// ---------------------------------------------------------------- Arc (5042)

/**
 * The Arc endpoints we actually rely on, best first.
 *
 * QuickNode is the preferred primary: measured ~2.4x faster than arc-scan on a
 * filtered getLogs (287ms vs ~700ms), and it retains noticeably more log
 * history — it still served ranges arc-scan had already pruned. Same ~10k-block
 * getLogs ceiling, so the chunked walk in swapLogs.ts stays correct either way.
 *
 * QuickNode does rate-limit, despite what an earlier comment here claimed:
 * sustained bursts come back as -32005, and pruned ranges usually come back as
 * a bare -32603 "internal error" rather than anything naming pruning. Both are
 * why the indexer retries a chunk before drawing any conclusion from a failure.
 *
 * arc-scan is kept alongside it, having been observed both capacity-limited and
 * briefly unreachable — which is precisely why the transport ranks rather than
 * pins.
 */
/**
 * Arc's block explorer.
 *
 * Previously arc-mainnet.cloud.blockscout.com, which is a dead vhost — it
 * answers "default backend - 404" at every path, so every explorer link on the
 * site and in the public API was broken. arc-scan.org is the only public Arc
 * explorer: explorer.arc.io sits behind Circle's Cloudflare Access, and no
 * other host answers at all.
 *
 * It is not especially reliable — it has been seen erroring on token pages, and
 * its RPC arm with it — but an explorer that is sometimes down beats one that is
 * permanently gone. Declared once here because this URL had drifted into four
 * separate copies, which is how it went stale unnoticed.
 */
export const ARC_EXPLORER_URL = "https://arc-scan.org";
export const ARC_EXPLORER_NAME = "Arc Scan";

export const ARC_PRIMARY_RPCS: readonly string[] = [
  "https://rpc.quicknode.mainnet.arc.io",
  "https://rpc.arc-scan.org",
];

/**
 * Emergency fallbacks only, for our own ranked transport.
 *
 * These are never offered to a wallet: both thirdweb entries have been observed
 * returning bare "Unauthorized" and an internal error, and a wallet does not
 * rank or fail over the way viem's fallback transport does — it simply uses
 * what it is handed.
 */
const ARC_FALLBACK_RPCS: readonly string[] = [
  "https://rpc.blockdaemon.mainnet.arc.io",
  "https://5042.rpc.thirdweb.com/8b0c89cd3b125e7f8f744f5e56f6436a",
  "https://5042.rpc.thirdweb.com",
];


const ARC: LaunchChain = {
  key: "arc",
  id: 5042,
  name: "Arc",
  shortName: "Arc",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: [
    ...envUrls(process.env["NEXT_PUBLIC_ARC_RPC_URLS"]),
    ...envUrls(process.env["NEXT_PUBLIC_ARC_RPC_URL"]),
    ...ARC_PRIMARY_RPCS,
    ...ARC_FALLBACK_RPCS,
  ],
  explorer: { name: ARC_EXPLORER_NAME, url: ARC_EXPLORER_URL },
  quote: {
    // Arc's native USDC: a 6-decimal ERC-20 view of the 18-decimal gas token.
    address: "0x3600000000000000000000000000000000000000",
    symbol: "USDC",
    decimals: 6,
    label: "native USDC",
  },
  // Read back from the deployed launchpad factory and from a live pool, not
  // copied from another chain. The previous values were wrong in a way that
  // could not fail loudly: positionManager was Uniswap's canonical mainnet
  // address (no contract at all on Arc) and swapRouter fell back to Base's
  // router, so trading depended entirely on an env override being present.
  uniswap: {
    factory: "0xf0db7b58379503491d857dB50AC9ece64c653918",
    positionManager: "0x39654A85A4C05127f5Fd6ED22CAeC077A0fB1377",
    swapRouter: (addr(process.env["NEXT_PUBLIC_UNISWAP_SWAP_ROUTER_ADDRESS"]) ??
      "0x4C91c54E60B59b1F949Af57064EA70bD73434720") as Hex,
  },
  poolFee: 10_000,
  factories: factoryList(process.env["NEXT_PUBLIC_ARCH_LAUNCHPAD_FACTORY_ADDRESS"], [
    "0x8e5732B520a318251a702a680AA7F123fb92AF52", // v4 — launch modes
    "0xE2aA88806872C2a02A4ab439584d457002983600", // v3 — fee recipient
    "0xA024664AD5d30F3c0b18b931DdB6f64A96DE8ED3", // v2 — SwapRouter02 fix
    "0x1d65ab4cDCDdA6f38A9c93a24EF64bE8905e19d5", // v1 — original
  ]),
  liquidityVault: addr(process.env["NEXT_PUBLIC_ARCH_LIQUIDITY_VAULT_ADDRESS"]),
  modeDistributor:
    addr(process.env["NEXT_PUBLIC_ARCH_MODE_DISTRIBUTOR_ADDRESS"]) ??
    "0x7c148B6a581E32CcB6ffF7Bd59AF4250d5ec1eBc",
  graduationUnits: graduationUnits(6),
  launchGasFloor: 40_000_000_000_000_000n, // ~0.04 native USDC
  live: true,
  accent: "#8b7dff",
};

// ------------------------------------------------------------------ registry

/** Arcanium launches on Arc. One chain, one quote asset, one story. */
export const CHAINS: readonly LaunchChain[] = [ARC];

export const DEFAULT_CHAIN_KEY: ChainKey = "arc";

const BY_KEY = new Map<ChainKey, LaunchChain>(CHAINS.map((c) => [c.key, c]));
const BY_ID = new Map<number, LaunchChain>(CHAINS.map((c) => [c.id, c]));

export function getChain(key: ChainKey): LaunchChain {
  const c = BY_KEY.get(key);
  if (c === undefined) throw new Error(`unknown chain: ${key}`);
  return c;
}

export function getChainById(id: number): LaunchChain | undefined {
  return BY_ID.get(id);
}

/** Resolve a URL/query value to a chain, falling back to the default. */
export function resolveChain(value: string | undefined | null): LaunchChain {
  if (value === undefined || value === null) return getChain(DEFAULT_CHAIN_KEY);
  const key = value.trim().toLowerCase();
  const byKey = BY_KEY.get(key as ChainKey);
  if (byKey !== undefined) return byKey;
  const asId = Number.parseInt(key, 10);
  if (Number.isFinite(asId)) {
    const byId = BY_ID.get(asId);
    if (byId !== undefined) return byId;
  }
  return getChain(DEFAULT_CHAIN_KEY);
}

/** Chains with a deployed stack — the ones a user can actually launch on. */
export function liveChains(): readonly LaunchChain[] {
  return CHAINS.filter((c) => c.live && c.factories.length > 0);
}

export function explorerToken(chain: LaunchChain, address: string): string {
  return `${chain.explorer.url}/token/${address}`;
}

export function explorerAddress(chain: LaunchChain, address: string): string {
  return `${chain.explorer.url}/address/${address}`;
}

export function explorerTx(chain: LaunchChain, hash: string): string {
  return `${chain.explorer.url}/tx/${hash}`;
}
