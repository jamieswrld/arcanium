import { NextResponse } from "next/server";
import { createPublicClient, createWalletClient, http, keccak256, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { MESSAGE_TRANSMITTER_V2, messageTransmitterAbi } from "@/lib/cctp";
import { bridgeChainByKey } from "@/lib/bridgeChains";

/**
 * CCTP mint relayer — the piece that makes arrival gasless. receiveMessage is
 * permissionless and always mints to the message's own mintRecipient, so the
 * relayer can pay destination gas with zero custody: a new user bridging to
 * Arc receives native USDC without holding any gas there. Guards: known
 * transmitter only, strict hex validation, size caps, in-flight dedup.
 */
export const dynamic = "force-dynamic";

const RELAYER_KEY = process.env["RELAYER_PRIVATE_KEY"] as Hex | undefined;
const ARC_RPC = process.env["ARC_RPC_SERVER_URL"];

/**
 * Chains this relayer will pay gas on.
 *
 * Relaying costs the relayer native gas on the destination, so it can only be
 * offered where that wallet is actually funded. Arc is the one that matters —
 * somebody bridging in has no gas there yet and could not claim for
 * themselves — and Base is kept because it already worked.
 *
 * Every other destination is self-claim: the user has gas there, since that is
 * where they are bridging to. receiveMessage is permissionless and always mints
 * to the message's own mintRecipient, so a self-claim is exactly as safe and
 * costs us nothing to not offer.
 */
const RELAYED = new Set(
  (process.env["BRIDGE_RELAY_CHAINS"] ?? "arc,base").split(",").map((s) => s.trim()).filter((s) => s !== ""),
);

const inFlight = new Set<string>();

/**
 * Which destinations we will claim on. The interface needs this before the
 * deposit is signed, not after: telling somebody the claim is covered and then
 * discovering it is not, once their USDC is already burned, is the one moment
 * in this flow where a wrong promise costs them something.
 */
export function GET(): NextResponse {
  return NextResponse.json({
    relayed: [...RELAYED],
    configured: RELAYER_KEY !== undefined,
  });
}

export async function POST(request: Request): Promise<NextResponse> {
  if (RELAYER_KEY === undefined) return NextResponse.json({ error: "relayer not configured" }, { status: 503 });
  const body = (await request.json().catch(() => null)) as { chain?: string; message?: string; attestation?: string } | null;
  const chainKey = body?.chain;
  const message = body?.message;
  const attestation = body?.attestation;
  if (
    chainKey === undefined ||
    !RELAYED.has(chainKey) ||
    bridgeChainByKey(chainKey) === undefined ||
    message === undefined || !/^0x[0-9a-fA-F]+$/.test(message) || message.length > 10_000 ||
    attestation === undefined || !/^0x[0-9a-fA-F]+$/.test(attestation) || attestation.length > 5_000
  ) {
    return NextResponse.json({ error: "invalid relay request" }, { status: 400 });
  }

  const key = keccak256(message as Hex);
  if (inFlight.has(key)) return NextResponse.json({ error: "relay already in flight" }, { status: 409 });
  inFlight.add(key);
  try {
    const c = bridgeChainByKey(chainKey);
    if (c === undefined) return NextResponse.json({ error: "unsupported chain" }, { status: 400 });
    // Arc's server RPC is overridable because it is the one we operate; the
    // rest use the registry's public endpoint.
    const rpc = c.key === "arc" ? (ARC_RPC ?? c.rpcUrl) : c.rpcUrl;
    const chain = {
      id: c.chainId,
      name: c.name,
      nativeCurrency: c.chain.nativeCurrency,
      rpcUrls: { default: { http: [rpc] } },
    };
    const account = privateKeyToAccount(RELAYER_KEY);
    const pub = createPublicClient({ chain, transport: http(rpc, { timeout: 20_000 }) });
    const wallet = createWalletClient({ account, chain, transport: http(rpc, { timeout: 20_000 }) });

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
