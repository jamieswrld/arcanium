import type { Hex } from "viem";
import {
  arbitrum,
  avalanche,
  base,
  linea,
  mainnet,
  optimism,
  polygon,
  sei,
  sonic,
  unichain,
  worldchain,
} from "viem/chains";
import type { Chain } from "viem";
import { arcTestnet } from "@/lib/bridgeClient";

/**
 * Every chain Arcanium can bridge USDC to and from.
 *
 * All of this is Circle's CCTP v2: USDC is burned on the source chain and
 * minted natively on the destination once Circle attests. There is no pool, no
 * wrapped asset and no Arcanium custody at any point — which is the only reason
 * supporting a dozen chains is a configuration problem rather than a security
 * one. A bridge that holds funds is the most attacked thing in this industry;
 * this one never holds any.
 *
 * Every address below was verified on-chain before being added: the USDC
 * contract, the TokenMessenger and the MessageTransmitter each confirmed to
 * have code on that network. Nothing here was copied from documentation and
 * trusted.
 *
 * BNB Smart Chain is deliberately absent. CCTP lists a domain for it (17), but
 * Circle does not publish a native USDC there — the common BNB "USDC" is a
 * bridged Binance-pegged asset, which is not the same thing and not what this
 * moves. Listing it would be offering a route that cannot work.
 *
 * Solana is absent for a different reason: it is CCTP-supported (domain 5) but
 * it is not EVM, so it needs a different wallet adapter and transaction format
 * rather than another row in this table.
 */

export interface BridgeChain {
  readonly key: string;
  readonly name: string;
  readonly chain: Chain;
  readonly chainId: number;
  /** Circle's CCTP domain — unrelated to the EIP-155 chain id. */
  readonly domain: number;
  readonly usdc: Hex;
  /** Public RPC used for reads when the wallet is elsewhere. */
  readonly rpcUrl: string;
  readonly explorer: string;
  /**
   * Arcanium's fee-taking router, where one is deployed. Chains without one
   * burn through CCTP's TokenMessenger directly and pay no protocol fee — a
   * route that works and earns nothing beats a route that does not exist.
   */
  readonly router?: Hex | undefined;
}

/** Contracts CCTP v2 deploys at the same CREATE2 address on every EVM chain. */
export const TOKEN_MESSENGER_V2: Hex = "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d";
export const MESSAGE_TRANSMITTER_V2: Hex = "0x81D40F21F12A8F0E3252Bccb954D722d4c464B64";

export const ARC: BridgeChain = {
  key: "arc",
  name: "Arc",
  chain: arcTestnet,
  chainId: 5042,
  domain: 26,
  usdc: "0x3600000000000000000000000000000000000000",
  rpcUrl: "https://rpc.quicknode.mainnet.arc.io",
  explorer: "https://arc-scan.org",
  router: (process.env["NEXT_PUBLIC_BRIDGE_ROUTER_ARC"] as Hex | undefined) ??
    "0x0dd474165985629ff88c718036a0ecd182338bfa",
};

export const BRIDGE_CHAINS: readonly BridgeChain[] = [
  {
    key: "ethereum",
    name: "Ethereum",
    chain: mainnet,
    chainId: 1,
    domain: 0,
    usdc: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    rpcUrl: "https://ethereum-rpc.publicnode.com",
    explorer: "https://etherscan.io",
  },
  {
    key: "base",
    name: "Base",
    chain: base,
    chainId: 8453,
    domain: 6,
    usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    rpcUrl: process.env["NEXT_PUBLIC_BASE_RPC_URL"] ?? "https://mainnet.base.org",
    explorer: "https://basescan.org",
    // The one chain besides Arc with a deployed router, so it keeps the
    // existing fee behaviour rather than silently changing it.
    router: (process.env["NEXT_PUBLIC_BRIDGE_ROUTER_BASE"] as Hex | undefined) ??
      "0x085ea6d98c6c8a0e5f05620bb13f34792fae1266",
  },
  {
    key: "arbitrum",
    name: "Arbitrum",
    chain: arbitrum,
    chainId: 42161,
    domain: 3,
    usdc: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    rpcUrl: "https://arb1.arbitrum.io/rpc",
    explorer: "https://arbiscan.io",
  },
  {
    key: "optimism",
    name: "OP Mainnet",
    chain: optimism,
    chainId: 10,
    domain: 2,
    usdc: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
    rpcUrl: "https://mainnet.optimism.io",
    explorer: "https://optimistic.etherscan.io",
  },
  {
    key: "polygon",
    name: "Polygon",
    chain: polygon,
    chainId: 137,
    domain: 7,
    usdc: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
    rpcUrl: "https://polygon-bor-rpc.publicnode.com",
    explorer: "https://polygonscan.com",
  },
  {
    key: "avalanche",
    name: "Avalanche",
    chain: avalanche,
    chainId: 43114,
    domain: 1,
    usdc: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E",
    rpcUrl: "https://api.avax.network/ext/bc/C/rpc",
    explorer: "https://snowtrace.io",
  },
  {
    key: "unichain",
    name: "Unichain",
    chain: unichain,
    chainId: 130,
    domain: 10,
    usdc: "0x078D782b760474a361dDA0AF3839290b0EF57AD6",
    rpcUrl: "https://mainnet.unichain.org",
    explorer: "https://uniscan.xyz",
  },
  {
    key: "linea",
    name: "Linea",
    chain: linea,
    chainId: 59144,
    domain: 11,
    usdc: "0x176211869cA2b568f2A7D4EE941E073a821EE1ff",
    rpcUrl: "https://rpc.linea.build",
    explorer: "https://lineascan.build",
  },
  {
    key: "sonic",
    name: "Sonic",
    chain: sonic,
    chainId: 146,
    domain: 13,
    usdc: "0x29219dd400f2Bf60E5a23d13Be72B486D4038894",
    rpcUrl: "https://rpc.soniclabs.com",
    explorer: "https://sonicscan.org",
  },
  {
    key: "worldchain",
    name: "World Chain",
    chain: worldchain,
    chainId: 480,
    domain: 14,
    usdc: "0x79A02482A880bCe3F13E09da970dC34dB4cD24D1",
    rpcUrl: "https://worldchain-mainnet.g.alchemy.com/public",
    explorer: "https://worldscan.org",
  },
  {
    key: "sei",
    name: "Sei",
    chain: sei,
    chainId: 1329,
    domain: 16,
    usdc: "0xe15fC38F6D8c56aF07bbCBe3BAf5708A2Bf42392",
    rpcUrl: "https://evm-rpc.sei-apis.com",
    explorer: "https://seitrace.com",
  },
];

export function bridgeChainByKey(key: string): BridgeChain | undefined {
  if (key === ARC.key) return ARC;
  return BRIDGE_CHAINS.find((c) => c.key === key);
}

export function bridgeChainById(chainId: number): BridgeChain | undefined {
  if (chainId === ARC.chainId) return ARC;
  return BRIDGE_CHAINS.find((c) => c.chainId === chainId);
}

/** Every chain including Arc, for pickers that allow either direction. */
export const ALL_BRIDGE_CHAINS: readonly BridgeChain[] = [ARC, ...BRIDGE_CHAINS];
