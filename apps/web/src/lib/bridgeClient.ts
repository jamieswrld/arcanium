import {
  defineChain,
  encodeAbiParameters,
  keccak256,
  type Hex,
} from "viem";
import { base, baseSepolia } from "viem/chains";
import { ARC_PRIMARY_RPCS } from "./chains";

/**
 * Client-side bridge constants and helpers. All financial math is bigint.
 * Addresses come from NEXT_PUBLIC env (set in Vercel), never hardcoded.
 */

const ARC_CHAIN_ID = Number(process.env["NEXT_PUBLIC_ARC_CHAIN_ID"] ?? "5042");

/** A single configured URL, or nothing. Keeps an unset env var out of the list
 *  rather than putting `undefined` in front of the endpoints that work. */
function envList(raw: string | undefined): string[] {
  return raw !== undefined && /^https?:\/\//.test(raw.trim()) ? [raw.trim()] : [];
}

export const arcTestnet = defineChain({
  id: ARC_CHAIN_ID,
  name: process.env["NEXT_PUBLIC_ARC_CHAIN_NAME"] ?? "Arc",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: {
    default: {
      /**
       * What the wallet is handed for wallet_addEthereumChain — and therefore
       * what it uses for its own estimates and receipts.
       *
       * This had drifted: it still named Blockdaemon as the primary long after
       * every read path in the app moved to QuickNode, so the wallet and the
       * site disagreed about which node Arc was. Sharing ARC_PRIMARY_RPCS is
       * what stops that happening again. Only the endpoints we would be content
       * to be pinned to are offered, since a wallet does not fail over.
       */
      http:
        ARC_CHAIN_ID === 5042
          ? [...envList(process.env["NEXT_PUBLIC_ARC_RPC_URL"]), ...ARC_PRIMARY_RPCS]
          : [process.env["NEXT_PUBLIC_ARC_RPC_URL"] ?? "https://rpc.blockdaemon.mainnet.arc.io"],
    },
  },
  blockExplorers: {
    default: { name: "Arc Explorer", url: process.env["NEXT_PUBLIC_ARC_EXPLORER_URL"] ?? "https://arc-mainnet.cloud.blockscout.com" },
  },
  // Multicall3 is deployed on Arc mainnet at the canonical address (verified
  // on-chain: 7,618 bytes of code). Declaring it is what lets viem fold a burst
  // of reads into one request — without it every balanceOf is its own eth_call,
  // and Arc drops a measurable share of any large parallel burst, which the
  // callers turn into a silent 0n. Only declared for 5042: the canonical
  // deployment is not guaranteed on any other id this env var could name.
  ...(ARC_CHAIN_ID === 5042
    ? { contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" as Hex } } }
    : {}),
  testnet: process.env["NEXT_PUBLIC_ARC_CHAIN_ID"] !== "5042",
});

export const baseChain = process.env["NEXT_PUBLIC_BASE_CHAIN_ID"] === "8453" ? base : baseSepolia;

// IMPORTANT: each NEXT_PUBLIC_* var must be read with a STATIC literal key so
// Next.js inlines its value into the client bundle at build time. Reading via
// a variable key (process.env[name]) is NOT statically analyzable — it stays
// `process.env[...]` in the browser and evaluates to undefined, which silently
// unconfigures every contract address. Do not refactor these into a loop/helper
// that passes the key as a variable.
function validAddr(v: string | undefined): Hex | undefined {
  return v !== undefined && /^0x[0-9a-fA-F]{40}$/.test(v) ? (v as Hex) : undefined;
}

export const VAULT_ADDRESS = validAddr(process.env["NEXT_PUBLIC_ARCH_VAULT_BASE_ADDRESS"]);
export const AUSD_ADDRESS = validAddr(process.env["NEXT_PUBLIC_ARCH_USD_ADDRESS"]);
export const BRIDGE_ADDRESS = validAddr(process.env["NEXT_PUBLIC_ARCH_BRIDGE_ARC_ADDRESS"]);
export const USDC_ADDRESS: Hex =
  validAddr(process.env["NEXT_PUBLIC_BASE_USDC_ADDRESS"]) ?? "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

/** Native Arc USDC (ERC-20 precompile view, 6 decimals) — the money tokens
 *  pair with once USDC launches are enabled. */
export const ARC_USDC_ADDRESS =
  validAddr(process.env["NEXT_PUBLIC_ARC_USDC_ADDRESS"]) ?? "0x3600000000000000000000000000000000000000";

/**
 * The launch/trade pair token and its display symbol. Defaults to aUSD so
 * nothing changes until the factory allows native USDC and this env var is
 * pointed at ARC_USDC_ADDRESS (the DYOR/Envelope "pair with the chain's money"
 * model). Both aUSD and the USDC ERC-20 view are 6 decimals, so quote math is
 * identical either way.
 */
export const PAIR_TOKEN_ADDRESS: Hex | undefined =
  validAddr(process.env["NEXT_PUBLIC_ARCH_PAIR_TOKEN_ADDRESS"]) ?? AUSD_ADDRESS;
export const PAIR_TOKEN_SYMBOL: string =
  process.env["NEXT_PUBLIC_ARCH_PAIR_TOKEN_SYMBOL"] ?? "aUSD";

export const BASE_EXPLORER = process.env["NEXT_PUBLIC_BASE_EXPLORER_URL"] ?? "https://sepolia.basescan.org";
export const ARC_EXPLORER = process.env["NEXT_PUBLIC_ARC_EXPLORER_URL"] ?? "https://arc.exploreme.pro";

export const vaultAbi = [
  { type: "function", name: "feeBps", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "minDeposit", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "maxDeposit", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "depositsPaused", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
  {
    type: "function",
    name: "deposit",
    stateMutability: "nonpayable",
    inputs: [
      { name: "amount", type: "uint256" },
      { name: "arcRecipient", type: "address" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "processedRedemptions",
    stateMutability: "view",
    inputs: [{ type: "bytes32" }],
    outputs: [{ type: "bool" }],
  },
  {
    type: "event",
    name: "Deposited",
    inputs: [
      { name: "sender", type: "address", indexed: true },
      { name: "arcRecipient", type: "address", indexed: true },
      { name: "grossAmount", type: "uint256", indexed: false },
      { name: "feeAmount", type: "uint256", indexed: false },
      { name: "netAmount", type: "uint256", indexed: false },
      { name: "nonce", type: "uint256", indexed: false },
    ],
  },
] as const;

export const bridgeAbi = [
  { type: "function", name: "minRedeem", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "redeemsPaused", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
  {
    type: "function",
    name: "redeem",
    stateMutability: "nonpayable",
    inputs: [
      { name: "amount", type: "uint256" },
      { name: "baseRecipient", type: "address" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "processedDeposits",
    stateMutability: "view",
    inputs: [{ type: "bytes32" }],
    outputs: [{ type: "bool" }],
  },
  {
    type: "event",
    name: "Redeemed",
    inputs: [
      { name: "sender", type: "address", indexed: true },
      { name: "baseRecipient", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
      { name: "nonce", type: "uint256", indexed: false },
    ],
  },
] as const;

export const erc20Abi = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [{ type: "address" }, { type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [{ type: "address" }, { type: "uint256" }],
    outputs: [{ type: "bool" }],
  },
] as const;

/** keccak256(abi.encode(txHash, logIndex)) — must match the contracts. */
export function bridgeActionId(sourceTxHash: Hex, logIndex: bigint): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "uint256" }],
      [sourceTxHash, logIndex],
    ),
  );
}

/** Parse a human decimal string to 6-decimal units. Throws on bad input. */
export function parseQuoteUnits(value: string): bigint {
  const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(value.trim());
  if (match === null) throw new SyntaxError("invalid amount");
  const whole = match[1] ?? "0";
  const frac = (match[2] ?? "").padEnd(6, "0");
  return BigInt(whole) * 1_000_000n + BigInt(frac === "" ? "0" : frac);
}

/** Format 6-decimal units as a plain decimal string (exact). */
export function formatQuoteUnits(units: bigint): string {
  const whole = units / 1_000_000n;
  const frac = units % 1_000_000n;
  if (frac === 0n) return whole.toLocaleString("en-US");
  return `${whole.toLocaleString("en-US")}.${frac.toString().padStart(6, "0").replace(/0+$/, "")}`;
}

/** amount × bps / 10000, truncating. */
export function applyBps(amount: bigint, bps: bigint): bigint {
  return (amount * bps) / 10_000n;
}
