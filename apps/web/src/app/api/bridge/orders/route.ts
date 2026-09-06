import { NextResponse } from "next/server";
import { createPublicClient, http, parseAbiItem, type Hex } from "viem";
import { base } from "viem/chains";
import { ARC_DOMAIN, BASE_DOMAIN, BRIDGE_ROUTER_ARC, BRIDGE_ROUTER_BASE } from "@/lib/cctp";

/**
 * Wallet-scoped bridge history, recovered from chain state rather than the
 * browser: scans our routers' Bridged events for this address on both chains
 * and pairs each with Circle's attestation status. A user who clears storage,
 * switches device, or deposited before we shipped local persistence still sees
 * (and can claim) their pending transfers.
 */
export const dynamic = "force-dynamic";

const bridgedEvent = parseAbiItem(
  "event Bridged(address indexed sender, uint32 indexed destinationDomain, bytes32 mintRecipient, uint256 amountIn, uint256 fee, uint256 amountBridged)",
);

const ARC_RPC = process.env["ARC_RPC_SERVER_URL"] ?? "https://rpc.blockdaemon.mainnet.arc.io";
const BASE_RPC = process.env["NEXT_PUBLIC_BASE_RPC_URL"] ?? "https://mainnet.base.org";

/** Base hard finality for CCTP standard transfers. */
const BASE_FINALITY_BLOCKS = 65;
const ARC_FINALITY_BLOCKS = 65;

/**
 * Log-range limits are per chain, because the two nodes are nothing alike.
 *
 * Base takes a 45,000-block range happily. Arc refuses anything much above
 * 10,000 — measured: 9,000 succeeds, 45,000 is refused. Both sides shared the
 * 45,000 constant, so every Arc chunk threw and broke the loop on its first
 * iteration: an Arc-to-Base bridge order has never appeared in this list.
 *
 * Each lookback is what eight chunks of that size actually reaches. Arc's works
 * out at ~10 hours of its half-second blocks, which comfortably covers an
 * in-flight CCTP transfer without making the route walk for 14 seconds.
 */
const BASE_LOOKBACK = 300_000n;
const BASE_CHUNK = 45_000n;
const ARC_LOOKBACK = 72_000n;
const ARC_CHUNK = 9_000n;
const MAX_CHUNKS = 8;

interface Order {
  burnTx: string;
  direction: "toArc" | "toBase";
  amountIn: string;
  amountBridged: string;
  blockNumber: string;
  confirmations: number;
  requiredConfirmations: number;
  status: "confirming" | "attesting" | "claimable" | "claimed";
}

export async function GET(request: Request): Promise<NextResponse> {
  const address = new URL(request.url).searchParams.get("address");
  if (address === null || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
    return NextResponse.json({ error: "address required" }, { status: 400 });
  }

  const chains = [
    { key: "toArc" as const, router: BRIDGE_ROUTER_BASE, rpc: BASE_RPC, chain: base, domain: BASE_DOMAIN, finality: BASE_FINALITY_BLOCKS, chunk: BASE_CHUNK, lookback: BASE_LOOKBACK },
    { key: "toBase" as const, router: BRIDGE_ROUTER_ARC, rpc: ARC_RPC, chain: undefined, domain: ARC_DOMAIN, finality: ARC_FINALITY_BLOCKS, chunk: ARC_CHUNK, lookback: ARC_LOOKBACK },
  ];

  const orders: Order[] = [];
  await Promise.all(
    chains.map(async (c) => {
      const client = createPublicClient({
        ...(c.chain !== undefined ? { chain: c.chain } : {}),
        transport: http(c.rpc, { timeout: 15_000 }),
      });
      const tip = await client.getBlockNumber().catch(() => null);
      if (tip === null) return;
      const floor = tip > c.lookback ? tip - c.lookback : 0n;
      let end = tip;
      for (let i = 0; i < MAX_CHUNKS && end > floor; i++) {
        const start = end >= c.chunk ? end - c.chunk + 1n : 0n;
        let logs;
        try {
          logs = await client.getLogs({
            address: c.router,
            event: bridgedEvent,
            args: { sender: address as Hex },
            fromBlock: start < floor ? floor : start,
            toBlock: end,
          });
        } catch { break; }
        for (const l of logs) {
          if (l.transactionHash === null || l.blockNumber === null) continue;
          const confirmations = Number(tip - l.blockNumber);
          orders.push({
            burnTx: l.transactionHash,
            direction: c.key,
            amountIn: (l.args.amountIn ?? 0n).toString(),
            amountBridged: (l.args.amountBridged ?? 0n).toString(),
            blockNumber: l.blockNumber.toString(),
            confirmations,
            requiredConfirmations: c.finality,
            status: "confirming",
          });
        }
        if (start === 0n) break;
        end = start - 1n;
      }
    }),
  );

  // Pair each with Circle's attestation state (and whether it's already used).
  await Promise.all(
    orders.map(async (o) => {
      const domain = o.direction === "toArc" ? BASE_DOMAIN : ARC_DOMAIN;
      try {
        const res = await fetch(`https://iris-api.circle.com/v2/messages/${domain}?transactionHash=${o.burnTx}`, {
          headers: { accept: "application/json" },
          cache: "no-store",
        });
        const body = (await res.json()) as { messages?: Array<{ status?: string }> };
        const st = body.messages?.[0]?.status;
        if (st === "complete") o.status = "claimable";
        else if (o.confirmations >= o.requiredConfirmations) o.status = "attesting";
        else o.status = "confirming";
      } catch {
        o.status = o.confirmations >= o.requiredConfirmations ? "attesting" : "confirming";
      }
    }),
  );

  orders.sort((a, b) => Number(BigInt(b.blockNumber) - BigInt(a.blockNumber)));
  return NextResponse.json({ orders: orders.slice(0, 20) });
}
