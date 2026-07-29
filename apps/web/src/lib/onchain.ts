import { createPublicClient, http, type Address, type PublicClient } from "viem";

/**
 * Server-side live chain reads. No mock data anywhere: every value on the
 * site either comes from a real RPC read or is explicitly labeled as not yet
 * deployed. Addresses and RPC URLs come from environment (Vercel project
 * settings in production).
 */

const BPS = 10_000n;

const vaultAbi = [
  {
    type: "function",
    name: "feeBps",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "minDeposit",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "maxDeposit",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "totalReserve",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "depositsPaused",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "bool" }],
  },
] as const;

const erc20SupplyAbi = [
  {
    type: "function",
    name: "totalSupply",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
] as const;

function rpc(url: string): PublicClient {
  return createPublicClient({ transport: http(url, { timeout: 4_000, retryCount: 1 }) });
}

function envAddress(name: string): Address | undefined {
  const value = process.env[name];
  return value !== undefined && /^0x[0-9a-fA-F]{40}$/.test(value)
    ? (value as Address)
    : undefined;
}

export interface ChainStatus {
  readonly ok: boolean;
  readonly blockNumber: bigint | null;
}

export interface LiveBridgeData {
  readonly base: ChainStatus;
  readonly arc: ChainStatus;
  /** null until the vault is deployed and its address configured. */
  readonly vault: {
    readonly address: Address;
    readonly feeBps: bigint;
    readonly minDeposit: bigint;
    readonly maxDeposit: bigint;
    readonly totalReserve: bigint;
    readonly depositsPaused: boolean;
  } | null;
  /** null until aUSD is deployed and its address configured. */
  readonly ausd: {
    readonly address: Address;
    readonly totalSupply: bigint;
  } | null;
}

const BASE_RPC =
  process.env["NEXT_PUBLIC_BASE_RPC_URL"] ?? "https://sepolia.base.org";
const ARC_RPC =
  process.env["NEXT_PUBLIC_ARC_RPC_URL"] ?? "https://rpc.testnet.arc.network";

async function chainStatus(client: PublicClient): Promise<ChainStatus> {
  try {
    return { ok: true, blockNumber: await client.getBlockNumber() };
  } catch {
    return { ok: false, blockNumber: null };
  }
}

const EMPTY: LiveBridgeData = { base: { ok: false, blockNumber: null }, arc: { ok: false, blockNumber: null }, vault: null, ausd: null };

/** Never let a slow RPC hang a page render. */
export async function getLiveBridgeData(): Promise<LiveBridgeData> {
  return await Promise.race([
    getLiveBridgeDataInner(),
    new Promise<LiveBridgeData>((resolve) => setTimeout(() => resolve(EMPTY), 6_000)),
  ]);
}

async function getLiveBridgeDataInner(): Promise<LiveBridgeData> {
  const baseClient = rpc(BASE_RPC);
  const arcClient = rpc(ARC_RPC);
  const vaultAddress = envAddress("NEXT_PUBLIC_ARCH_VAULT_BASE_ADDRESS");
  const ausdAddress = envAddress("NEXT_PUBLIC_ARCH_USD_ADDRESS");

  const [base, arc] = await Promise.all([
    chainStatus(baseClient),
    chainStatus(arcClient),
  ]);

  let vault: LiveBridgeData["vault"] = null;
  if (vaultAddress !== undefined) {
    try {
      const [feeBps, minDeposit, maxDeposit, totalReserve, depositsPaused] =
        await Promise.all([
          baseClient.readContract({ address: vaultAddress, abi: vaultAbi, functionName: "feeBps" }),
          baseClient.readContract({ address: vaultAddress, abi: vaultAbi, functionName: "minDeposit" }),
          baseClient.readContract({ address: vaultAddress, abi: vaultAbi, functionName: "maxDeposit" }),
          baseClient.readContract({ address: vaultAddress, abi: vaultAbi, functionName: "totalReserve" }),
          baseClient.readContract({ address: vaultAddress, abi: vaultAbi, functionName: "depositsPaused" }),
        ]);
      vault = { address: vaultAddress, feeBps, minDeposit, maxDeposit, totalReserve, depositsPaused };
    } catch {
      vault = null;
    }
  }

  let ausd: LiveBridgeData["ausd"] = null;
  if (ausdAddress !== undefined) {
    try {
      const totalSupply = await arcClient.readContract({
        address: ausdAddress,
        abi: erc20SupplyAbi,
        functionName: "totalSupply",
      });
      ausd = { address: ausdAddress, totalSupply };
    } catch {
      ausd = null;
    }
  }

  return { base, arc, vault, ausd };
}

/** Format a bps value as a percentage string with exact integer math. */
export function bpsToPercent(bps: bigint): string {
  const whole = bps / 100n;
  const frac = bps % 100n;
  return frac === 0n
    ? `${whole}%`
    : `${whole}.${frac.toString().padStart(2, "0").replace(/0$/, "")}%`;
}

/** Format 6-decimal units as a plain decimal string (exact, no floats). */
export function formatQuoteUnits(units: bigint): string {
  const whole = units / 1_000_000n;
  const frac = units % 1_000_000n;
  const wholeStr = whole.toLocaleString("en-US");
  if (frac === 0n) return wholeStr;
  return `${wholeStr}.${frac.toString().padStart(6, "0").replace(/0+$/, "")}`;
}

/** Net rate after fee: "1 USDC = 0.85 aUSD" for 1500 bps. */
export function netRate(feeBps: bigint): string {
  const net = BPS - feeBps;
  const whole = net / BPS;
  const frac = net % BPS;
  return frac === 0n
    ? `${whole}`
    : `${whole}.${frac.toString().padStart(4, "0").replace(/0+$/, "")}`;
}
