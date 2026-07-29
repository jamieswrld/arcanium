import { NextResponse } from "next/server";
import { createPublicClient, fallback, http, type Hex } from "viem";

/**
 * Live bridge solvency: the reserve backing on Base vs the aUSD supply on Arc.
 * The single most important public health metric — anyone can verify Arch is
 * fully backed at any moment.
 */

const vaultAbi = [
  { type: "function", name: "totalReserve", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;
const supplyAbi = [
  { type: "function", name: "totalSupply", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;

const VAULT = process.env["NEXT_PUBLIC_ARCH_VAULT_BASE_ADDRESS"] as Hex | undefined;
const AUSD = process.env["NEXT_PUBLIC_ARCH_USD_ADDRESS"] as Hex | undefined;

const baseTransport = http(process.env["NEXT_PUBLIC_BASE_RPC_URL"] ?? "https://sepolia.base.org");
const arcTransport = fallback([
  http(process.env["ARC_RPC_SERVER_URL"] ?? "https://5042002.rpc.thirdweb.com"),
  http("https://arc-testnet.drpc.org"),
]);

export async function GET(): Promise<NextResponse> {
  if (VAULT === undefined || AUSD === undefined) {
    return NextResponse.json({ error: "bridge not configured" }, { status: 503 });
  }
  try {
    const base = createPublicClient({ transport: baseTransport });
    const arc = createPublicClient({ transport: arcTransport });
    const [reserve, supply] = await Promise.all([
      base.readContract({ address: VAULT, abi: vaultAbi, functionName: "totalReserve" }),
      arc.readContract({ address: AUSD, abi: supplyAbi, functionName: "totalSupply" }),
    ]);
    return NextResponse.json({
      reserveUnits: reserve.toString(),
      supplyUnits: supply.toString(),
      surplusUnits: (reserve - supply).toString(),
      ratioBps: supply === 0n ? null : ((reserve * 10_000n) / supply).toString(),
      solvent: reserve >= supply,
      reserveUsd: (Number(reserve) / 1e6).toFixed(2),
      supplyUsd: (Number(supply) / 1e6).toFixed(2),
    });
  } catch (err) {
    const message = err instanceof Error ? (err.message.split("\n")[0] ?? "failed") : "failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
