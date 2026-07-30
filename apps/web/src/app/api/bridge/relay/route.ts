import { NextResponse } from "next/server";
import { createPublicClient, createWalletClient, http, keccak256, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { MESSAGE_TRANSMITTER_V2, messageTransmitterAbi } from "@/lib/cctp";

/**
 * CCTP mint relayer — the piece that makes arrival gasless. receiveMessage is
 * permissionless and always mints to the message's own mintRecipient, so the
 * relayer can pay destination gas with zero custody: a new user bridging to
 * Arc receives native USDC without holding any gas there. Guards: known
 * transmitter only, strict hex validation, size caps, in-flight dedup.
 */
export const dynamic = "force-dynamic";

const RELAYER_KEY = process.env["RELAYER_PRIVATE_KEY"] as Hex | undefined;
const ARC_RPC = process.env["ARC_RPC_SERVER_URL"] ?? "https://rpc.blockdaemon.mainnet.arc.io";
const BASE_RPC = process.env["NEXT_PUBLIC_BASE_RPC_URL"] ?? "https://mainnet.base.org";

const CHAINS = {
  arc: { id: 5042, name: "arc", rpc: ARC_RPC, currency: { name: "USDC", symbol: "USDC", decimals: 18 } },
  base: { id: 8453, name: "base", rpc: BASE_RPC, currency: { name: "ETH", symbol: "ETH", decimals: 18 } },
} as const;

const inFlight = new Set<string>();

export async function POST(request: Request): Promise<NextResponse> {
  if (RELAYER_KEY === undefined) return NextResponse.json({ error: "relayer not configured" }, { status: 503 });
  const body = (await request.json().catch(() => null)) as { chain?: string; message?: string; attestation?: string } | null;
  const chainKey = body?.chain;
  const message = body?.message;
  const attestation = body?.attestation;
  if (
    (chainKey !== "arc" && chainKey !== "base") ||
    message === undefined || !/^0x[0-9a-fA-F]+$/.test(message) || message.length > 10_000 ||
    attestation === undefined || !/^0x[0-9a-fA-F]+$/.test(attestation) || attestation.length > 5_000
  ) {
    return NextResponse.json({ error: "invalid relay request" }, { status: 400 });
  }

  const key = keccak256(message as Hex);
  if (inFlight.has(key)) return NextResponse.json({ error: "relay already in flight" }, { status: 409 });
  inFlight.add(key);
  try {
    const c = CHAINS[chainKey];
    const chain = { id: c.id, name: c.name, nativeCurrency: c.currency, rpcUrls: { default: { http: [c.rpc] } } };
    const account = privateKeyToAccount(RELAYER_KEY);
    const pub = createPublicClient({ chain, transport: http(c.rpc, { timeout: 20_000 }) });
    const wallet = createWalletClient({ account, chain, transport: http(c.rpc, { timeout: 20_000 }) });

    // Simulate first: an already-received or invalid message fails cheaply
    // here instead of wasting relayer gas.
    await pub.simulateContract({
      account,
      address: MESSAGE_TRANSMITTER_V2,
      abi: messageTransmitterAbi,
      functionName: "receiveMessage",
      args: [message as Hex, attestation as Hex],
    });

    const txHash = await wallet.writeContract({
      address: MESSAGE_TRANSMITTER_V2,
      abi: messageTransmitterAbi,
      functionName: "receiveMessage",
      args: [message as Hex, attestation as Hex],
      gas: 400_000n,
    });
    const receipt = await pub.waitForTransactionReceipt({ hash: txHash, timeout: 60_000 }).catch(() => null);
    return NextResponse.json({
      txHash,
      status: receipt === null ? "submitted" : receipt.status === "success" ? "confirmed" : "reverted",
    });
  } catch (err) {
    const raw = err instanceof Error ? (err.message.split("\n")[0] ?? "relay failed") : "relay failed";
    const friendly = /nonce already used|already received/i.test(raw) ? "Already minted on the destination." : raw;
    return NextResponse.json({ error: friendly }, { status: 502 });
  } finally {
    inFlight.delete(key);
  }
}
