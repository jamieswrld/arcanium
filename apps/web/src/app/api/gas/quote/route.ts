import { NextResponse } from "next/server";
import { createPublicClient, fallback, http, type Hex } from "viem";

/**
 * Gas-station quote endpoint (server-side relayer component).
 * Reads the live Arc gas price and the station's on-chain quote so the number
 * the user signs is exactly what the contract will accept.
 */

const stationAbi = [
  {
    type: "function",
    name: "quote",
    stateMutability: "view",
    inputs: [
      { name: "actionId", type: "uint256" },
      { name: "gasPrice", type: "uint256" },
    ],
    outputs: [
      { name: "nativeOut", type: "uint256" },
      { name: "ausdIn", type: "uint256" },
    ],
  },
  { type: "function", name: "marginBps", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;

const arcTransport = fallback([
  http(process.env["ARC_RPC_SERVER_URL"] ?? "https://5042002.rpc.thirdweb.com"),
  http("https://arc-testnet.drpc.org"),
  http("https://rpc.testnet.arc.network"),
]);
const STATION = process.env["NEXT_PUBLIC_ARCH_GAS_STATION_ADDRESS"] as Hex | undefined;
const QUOTE_TTL_SECONDS = 120;

export async function POST(request: Request): Promise<NextResponse> {
  try {
    return await handleQuote(request);
  } catch (err) {
    const message = err instanceof Error ? (err.message.split("\n")[0] ?? "quote failed") : "quote failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}

async function handleQuote(request: Request): Promise<NextResponse> {
  if (STATION === undefined) {
    return NextResponse.json({ error: "gas station not configured" }, { status: 503 });
  }
  const body = (await request.json().catch(() => null)) as { actionId?: number } | null;
  const actionId = body?.actionId;
  if (actionId === undefined || !Number.isInteger(actionId) || actionId < 0 || actionId > 3) {
    return NextResponse.json({ error: "actionId must be 0..3" }, { status: 400 });
  }

  const arc = createPublicClient({ transport: arcTransport });
  const [gasPrice, chainId] = await Promise.all([arc.getGasPrice(), arc.getChainId()]);
  // Safety buffer over the observed gas price so quotes survive small spikes.
  const bufferedGasPrice = (gasPrice * 125n) / 100n;
  const [nativeOut, ausdIn] = await arc.readContract({
    address: STATION,
    abi: stationAbi,
    functionName: "quote",
    args: [BigInt(actionId), bufferedGasPrice],
  });
  const marginBps = await arc.readContract({ address: STATION, abi: stationAbi, functionName: "marginBps" });

  const parAusd = (nativeOut + 10n ** 12n - 1n) / 10n ** 12n;
  return NextResponse.json({
    actionId,
    nativeOut: nativeOut.toString(),
    aUsdIn: ausdIn.toString(),
    networkFee: parAusd.toString(),
    serviceMargin: (ausdIn - parAusd).toString(),
    gasPrice: bufferedGasPrice.toString(),
    expiresAt: new Date(Date.now() + QUOTE_TTL_SECONDS * 1000).toISOString(),
    chainId: chainId.toString(),
    permitSpender: STATION,
  });
}
