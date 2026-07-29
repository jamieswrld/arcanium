import { NextResponse } from "next/server";
import { createPublicClient, createWalletClient, fallback, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

/**
 * Gas-station drip endpoint (server-side relayer).
 * Submits the user's permit-authorized drip. The contract enforces caps,
 * cooldown, pricing, and relayer-only execution; this layer adds in-flight
 * duplicate detection (409) and input validation. The relayer key is a
 * server-only environment variable (never NEXT_PUBLIC), holding a small
 * operational float only.
 */

const stationAbi = [
  {
    type: "function",
    name: "drip",
    stateMutability: "nonpayable",
    inputs: [
      { name: "user", type: "address" },
      { name: "actionId", type: "uint8" },
      { name: "nativeOut", type: "uint256" },
      { name: "ausdIn", type: "uint256" },
      { name: "deadline", type: "uint256" },
      { name: "v", type: "uint8" },
      { name: "r", type: "bytes32" },
      { name: "s", type: "bytes32" },
    ],
    outputs: [],
  },
] as const;

const arcTransport = fallback([
  http(process.env["ARC_RPC_SERVER_URL"] ?? "https://5042002.rpc.thirdweb.com"),
  http("https://arc-testnet.drpc.org"),
  http("https://rpc.testnet.arc.network"),
]);
const STATION = process.env["NEXT_PUBLIC_ARCH_GAS_STATION_ADDRESS"] as Hex | undefined;
const RELAYER_KEY = process.env["RELAYER_PRIVATE_KEY"] as Hex | undefined;

const inFlight = new Set<string>();

interface DripBody {
  readonly user?: string;
  readonly actionId?: number;
  readonly nativeOut?: string;
  readonly ausdIn?: string;
  readonly deadline?: string;
  readonly v?: number;
  readonly r?: string;
  readonly s?: string;
}

export async function POST(request: Request): Promise<NextResponse> {
  if (STATION === undefined || RELAYER_KEY === undefined) {
    return NextResponse.json({ error: "relayer not configured" }, { status: 503 });
  }
  const body = (await request.json().catch(() => null)) as DripBody | null;
  if (
    body === null ||
    body.user === undefined || !/^0x[0-9a-fA-F]{40}$/.test(body.user) ||
    body.actionId === undefined || !Number.isInteger(body.actionId) || body.actionId < 0 || body.actionId > 3 ||
    body.nativeOut === undefined || !/^[0-9]+$/.test(body.nativeOut) ||
    body.ausdIn === undefined || !/^[0-9]+$/.test(body.ausdIn) ||
    body.deadline === undefined || !/^[0-9]+$/.test(body.deadline) ||
    body.v === undefined ||
    body.r === undefined || !/^0x[0-9a-fA-F]{64}$/.test(body.r) ||
    body.s === undefined || !/^0x[0-9a-fA-F]{64}$/.test(body.s)
  ) {
    return NextResponse.json({ error: "invalid drip request" }, { status: 400 });
  }

  const key = `${body.user.toLowerCase()}:${body.actionId}`;
  if (inFlight.has(key)) {
    return NextResponse.json({ error: "drip already in flight for this user/action" }, { status: 409 });
  }
  inFlight.add(key);
  try {
    const account = privateKeyToAccount(RELAYER_KEY);
    const arc = createPublicClient({ transport: arcTransport });
    const wallet = createWalletClient({ account, transport: arcTransport });
    const txHash = await wallet.writeContract({
      chain: null,
      address: STATION,
      abi: stationAbi,
      functionName: "drip",
      args: [
        body.user as Hex,
        body.actionId,
        BigInt(body.nativeOut),
        BigInt(body.ausdIn),
        BigInt(body.deadline),
        body.v,
        body.r as Hex,
        body.s as Hex,
      ],
    });
    const receipt = await arc.waitForTransactionReceipt({ hash: txHash, timeout: 30_000 }).catch(() => null);
    return NextResponse.json({
      txHash,
      status: receipt === null ? "submitted" : receipt.status === "success" ? "confirmed" : "reverted",
      explorer: `https://testnet.arcscan.app/tx/${txHash}`,
    });
  } catch (err) {
    const message = err instanceof Error ? (err.message.split("\n")[0] ?? "drip failed") : "drip failed";
    return NextResponse.json({ error: message }, { status: 502 });
  } finally {
    inFlight.delete(key);
  }
}
