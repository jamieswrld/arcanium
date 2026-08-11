import type { Hex } from "viem";

/**
 * The chains Arcanium launches on.
 *
 * Every chain runs the identical stack — factory, liquidity vault, mode
 * distributor — so a launch behaves the same everywhere: fixed 1B supply, a real
 * Uniswap v3 pool from block one at a ~$3,000 cap, the whole supply locked in a
 * single-sided position, 90/10 protocol/creator fee split, and the Divium /
 * Arcane modes. Only the addresses and the quote asset differ.
 *
 * The one thing that is NOT interchangeable is the quote token's decimals: the
 * launch price constants differ between a 6-decimal quote (Arc USDC, Robinhood
 * USDG) and an 18-decimal one (BNB USDT). Factory v5 picks the right set from
 * the quote token itself, so this table only has to name the token.
 *
 * NOTE ON ENV VARS: Next.js only inlines `process.env.X` when X is a *static
 * literal*. `process.env[someVariable]` is silently undefined in the browser —
 * that bug once made every address disappear client-side. So each chain spells
 * its overrides out longhand. Do not refactor these into a loop.
 */

export type ChainKey = "arc" | "robinhood" | "bnb";

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
  /** Pool fee tier used for every launch. tickSpacing 200 on all three chains. */
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

const ARC: LaunchChain = {
  key: "arc",
  id: 5042,
  name: "Arc",
  shortName: "Arc",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: [
    ...envUrls(process.env["NEXT_PUBLIC_ARC_RPC_URLS"]),
    ...envUrls(process.env["NEXT_PUBLIC_ARC_RPC_URL"]),
    "https://rpc.blockdaemon.mainnet.arc.io",
    "https://5042.rpc.thirdweb.com/8b0c89cd3b125e7f8f744f5e56f6436a",
    "https://5042.rpc.thirdweb.com",
  ],
  explorer: { name: "Blockscout", url: "https://arc-mainnet.cloud.blockscout.com" },
  quote: {
    // Arc's native USDC: a 6-decimal ERC-20 view of the 18-decimal gas token.
    address: "0x3600000000000000000000000000000000000000",
    symbol: "USDC",
    decimals: 6,
    label: "native USDC",
  },
  uniswap: {
    factory: "0x33F26c5d1eE1B8Bd6C4A8B0C0e1C4B37F9a5D3e2",
    positionManager: "0xC36442b4a4522E871399CD717aBDD847Ab11FE88",
    swapRouter: (addr(process.env["NEXT_PUBLIC_UNISWAP_SWAP_ROUTER_ADDRESS"]) ??
      "0x2626664c2603336E57B271c5C0b26F421741e481") as Hex,
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

// -------------------------------------------------------- Robinhood (4663)

const ROBINHOOD: LaunchChain = {
  key: "robinhood",
  id: 4663,
  name: "Robinhood Chain",
  shortName: "Robinhood",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: [
    ...envUrls(process.env["NEXT_PUBLIC_ROBINHOOD_RPC_URLS"]),
    "https://rpc.mainnet.chain.robinhood.com",
    "https://robinhood.drpc.org",
  ],
  explorer: { name: "Blockscout", url: "https://robinhoodchain.blockscout.com" },
  quote: {
    // USDG (Global Dollar) — 6 decimals, verified on-chain.
    address: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
    symbol: "USDG",
    decimals: 6,
    label: "USDG",
  },
  uniswap: {
    factory: "0x1f7d7550B1b028f7571E69A784071F0205FD2EfA",
    positionManager: "0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3",
    swapRouter: "0xCaf681a66D020601342297493863E78C959E5cb2",
    quoter: "0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7",
  },
  poolFee: 10_000,
  factories: factoryList(process.env["NEXT_PUBLIC_ROBINHOOD_FACTORY_ADDRESS"], [
    "0x81D414D2cD66bf4422036846f569a6189996Fd59", // v5 — decimals-aware pricing
  ]),
  liquidityVault:
    addr(process.env["NEXT_PUBLIC_ROBINHOOD_LIQUIDITY_VAULT_ADDRESS"]) ??
    "0x4297254E5ae2df2b0d3920A08Df582D61b3e7766",
  modeDistributor:
    addr(process.env["NEXT_PUBLIC_ROBINHOOD_MODE_DISTRIBUTOR_ADDRESS"]) ??
    "0x472580431Fb124e376E8b07802e64d2cEc4001DE",
  graduationUnits: graduationUnits(6),
  launchGasFloor: 2_000_000_000_000_000n, // 0.002 ETH — a launch costs ~0.0005
  live: true,
  accent: "#00c805",
};

// -------------------------------------------------------------- BNB (56)

const BNB: LaunchChain = {
  key: "bnb",
  id: 56,
  name: "BNB Chain",
  shortName: "BNB",
  nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 },
  rpcUrls: [
    ...envUrls(process.env["NEXT_PUBLIC_BNB_RPC_URLS"]),
    "https://bsc-dataseed.bnbchain.org",
    "https://bsc-rpc.publicnode.com",
    "https://bsc-dataseed1.defibit.io",
    "https://bsc-dataseed1.ninicoin.io",
    "https://bsc.drpc.org",
    "https://bsc-dataseed2.bnbchain.org",
    "https://1rpc.io/bnb",
  ],
  explorer: { name: "BscScan", url: "https://bscscan.com" },
  quote: {
    // BSC-USD (Binance-Peg USDT) — 18 decimals, verified on-chain. This is why
    // factory v5 exists: v4's price constants assume a 6-decimal quote.
    address: "0x55d398326f99059fF775485246999027B3197955",
    symbol: "USDT",
    decimals: 18,
    label: "USDT",
  },
  uniswap: {
    factory: "0xdB1d10011AD0Ff90774D0C6Bb92e5C5c8b4461F7",
    positionManager: "0x7b8A01B39D58278b5DE7e48c8449c9f4F5170613",
    swapRouter: "0xB971eF87ede563556b2ED4b1C0b0019111Dd85d2",
    quoter: "0x78D78E420Da98ad378D7799bE8f4AF69033EB077",
  },
  poolFee: 10_000,
  factories: factoryList(process.env["NEXT_PUBLIC_BNB_FACTORY_ADDRESS"], [
    "0x81D414D2cD66bf4422036846f569a6189996Fd59", // v5 — decimals-aware pricing
  ]),
  liquidityVault:
    addr(process.env["NEXT_PUBLIC_BNB_LIQUIDITY_VAULT_ADDRESS"]) ??
    "0x4297254E5ae2df2b0d3920A08Df582D61b3e7766",
  modeDistributor:
    addr(process.env["NEXT_PUBLIC_BNB_MODE_DISTRIBUTOR_ADDRESS"]) ??
    "0x472580431Fb124e376E8b07802e64d2cEc4001DE",
  graduationUnits: graduationUnits(18),
  launchGasFloor: 2_000_000_000_000_000n, // 0.002 BNB — a launch costs ~0.0005
  live: true,
  accent: "#f0b90b",
};

// ------------------------------------------------------------------ registry

export const CHAINS: readonly LaunchChain[] = [ARC, ROBINHOOD, BNB];

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
