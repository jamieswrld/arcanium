import type { Chain } from "viem";
import type { ArchEnv } from "@arch/config";

export type ArchNetworkName =
  | "baseSepolia"
  | "baseMainnet"
  | "arcTestnet"
  | "arcMainnet";

export interface ArchNetwork {
  readonly name: ArchNetworkName;
  readonly chain: Chain;
  readonly rpcUrl: string;
  readonly explorerUrl: string;
  /** USDC ERC-20 address on this network (6-decimal interface). */
  readonly usdcAddress: `0x${string}` | undefined;
  /** Blocks a bridge worker must wait before acting on an event. */
  readonly confirmations: number;
  /**
   * On Arc, gas (native view) uses 18 decimals while the USDC ERC-20 view uses
   * 6 — same underlying balance, two representations (verified from Circle
   * docs). Non-Arc networks use the conventional native-18 / token-6 split.
   */
  readonly nativeIsUsdc: boolean;
}

function defineChain(params: {
  id: number;
  name: string;
  rpcUrl: string;
  explorerUrl: string;
  nativeCurrency: { name: string; symbol: string; decimals: number };
  testnet: boolean;
}): Chain {
  return {
    id: params.id,
    name: params.name,
    nativeCurrency: params.nativeCurrency,
    rpcUrls: { default: { http: [params.rpcUrl] } },
    blockExplorers: {
      default: { name: `${params.name} Explorer`, url: params.explorerUrl },
    },
    testnet: params.testnet,
  };
}

/**
 * Build the network table from validated env. arcMainnet is only present when
 * ENABLE_ARC_MAINNET=true and its full address book is configured (enforced by
 * the env schema — ADR 0006).
 */
export function buildNetworks(
  env: ArchEnv,
): Partial<Record<ArchNetworkName, ArchNetwork>> {
  const networks: Partial<Record<ArchNetworkName, ArchNetwork>> = {};

  if (env.BASE_SEPOLIA_RPC_URL !== undefined) {
    networks.baseSepolia = {
      name: "baseSepolia",
      rpcUrl: env.BASE_SEPOLIA_RPC_URL,
      explorerUrl: env.BASE_SEPOLIA_EXPLORER_URL,
      usdcAddress: env.BASE_SEPOLIA_USDC_ADDRESS as `0x${string}` | undefined,
      confirmations: env.BASE_SEPOLIA_CONFIRMATIONS,
      nativeIsUsdc: false,
      chain: defineChain({
        id: env.BASE_SEPOLIA_CHAIN_ID,
        name: "Base Sepolia",
        rpcUrl: env.BASE_SEPOLIA_RPC_URL,
        explorerUrl: env.BASE_SEPOLIA_EXPLORER_URL,
        nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
        testnet: true,
      }),
    };
  }

  if (env.BASE_MAINNET_RPC_URL !== undefined) {
    networks.baseMainnet = {
      name: "baseMainnet",
      rpcUrl: env.BASE_MAINNET_RPC_URL,
      explorerUrl: env.BASE_MAINNET_EXPLORER_URL,
      usdcAddress: env.BASE_MAINNET_USDC_ADDRESS as `0x${string}` | undefined,
      confirmations: env.BASE_MAINNET_CONFIRMATIONS,
      nativeIsUsdc: false,
      chain: defineChain({
        id: env.BASE_MAINNET_CHAIN_ID,
        name: "Base",
        rpcUrl: env.BASE_MAINNET_RPC_URL,
        explorerUrl: env.BASE_MAINNET_EXPLORER_URL,
        nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
        testnet: false,
      }),
    };
  }

  networks.arcTestnet = {
    name: "arcTestnet",
    rpcUrl: env.ARC_TESTNET_RPC_URL,
    explorerUrl: env.ARC_TESTNET_EXPLORER_URL,
    usdcAddress: env.ARC_TESTNET_USDC_ADDRESS as `0x${string}`,
    confirmations: env.ARC_TESTNET_CONFIRMATIONS,
    nativeIsUsdc: true,
    chain: defineChain({
      id: env.ARC_TESTNET_CHAIN_ID,
      name: "Arc Testnet",
      rpcUrl: env.ARC_TESTNET_RPC_URL,
      explorerUrl: env.ARC_TESTNET_EXPLORER_URL,
      // Native view is 18-decimal USDC (gas); ERC-20 view is 6.
      nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
      testnet: true,
    }),
  };

  if (
    env.ENABLE_ARC_MAINNET &&
    env.ARC_MAINNET_RPC_URL !== undefined &&
    env.ARC_MAINNET_EXPLORER_URL !== undefined &&
    env.ARC_MAINNET_CHAIN_ID !== undefined
  ) {
    networks.arcMainnet = {
      name: "arcMainnet",
      rpcUrl: env.ARC_MAINNET_RPC_URL,
      explorerUrl: env.ARC_MAINNET_EXPLORER_URL,
      usdcAddress: env.ARC_MAINNET_USDC_ADDRESS as `0x${string}` | undefined,
      confirmations: env.ARC_MAINNET_CONFIRMATIONS,
      nativeIsUsdc: true,
      chain: defineChain({
        id: env.ARC_MAINNET_CHAIN_ID,
        name: "Arc",
        rpcUrl: env.ARC_MAINNET_RPC_URL,
        explorerUrl: env.ARC_MAINNET_EXPLORER_URL,
        nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
        testnet: false,
      }),
    };
  }

  return networks;
}

/** Decimals of the ERC-20 USDC/aUSD interfaces. */
export const QUOTE_DECIMALS = 6;
/** Decimals of Arc's native gas view of USDC. */
export const ARC_NATIVE_GAS_DECIMALS = 18;
/** Decimals of every Arch launch token. */
export const LAUNCH_TOKEN_DECIMALS = 18;
/** Fixed launch supply: 1,000,000,000 tokens with 18 decimals. */
export const LAUNCH_TOKEN_SUPPLY = 1_000_000_000n * 10n ** 18n;

/** Convert Arc native (18d) gas value to its 6-decimal USDC representation, truncating. */
export function arcNativeToUsdcUnits(nativeWei: bigint): bigint {
  return nativeWei / 10n ** 12n;
}

/** Convert 6-decimal USDC units to Arc native (18d) representation. */
export function usdcUnitsToArcNative(usdcUnits: bigint): bigint {
  return usdcUnits * 10n ** 12n;
}

/** Deployed Arcanium contracts on Arc. The canonical list — see the file. */
export * from "./deployments.js";
