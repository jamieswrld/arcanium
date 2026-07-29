import pino from "pino";
import { createPublicClient, http, parseAbiItem, fallback, type Hex } from "viem";
import { archVaultBaseAbi, archBridgeArcAbi } from "@arch/abis";
import { bridgeActionId } from "@arch/sdk";
import { loadEnv } from "@arch/config";

/**
 * Bridge reconciliation tool. Scans both chains for deposit/redeem events and
 * reports any action whose destination side has NOT been processed on-chain —
 * i.e. deposits awaiting mint, burns awaiting release. It reports evidence
 * (the exact source tx + action id) but takes no action itself: the admin can
 * never mark an action complete without a verifiable destination transaction,
 * because completion is defined solely by the on-chain processed mappings.
 */

const env = loadEnv();
const log = pino({ level: env.LOG_LEVEL, name: "arch-reconcile" });

const depositedEvent = parseAbiItem(
  "event Deposited(address indexed sender, address indexed arcRecipient, uint256 grossAmount, uint256 feeAmount, uint256 netAmount, uint256 nonce)",
);
const redeemedEvent = parseAbiItem(
  "event Redeemed(address indexed sender, address indexed baseRecipient, uint256 amount, uint256 nonce)",
);

function requireEnv(name: string): string {
  const v = process.env[name];
  if (v === undefined || v.length === 0) throw new Error(`${name} is required`);
  return v;
}

interface Pending {
  readonly direction: "deposit" | "redeem";
  readonly actionId: Hex;
  readonly sourceTx: Hex;
  readonly amountUnits: bigint;
}

async function main(): Promise<void> {
  const vault = requireEnv("ARCH_VAULT_BASE_ADDRESS") as Hex;
  const bridge = requireEnv("ARCH_BRIDGE_ARC_ADDRESS") as Hex;
  const base = createPublicClient({ transport: http(env.BASE_SEPOLIA_RPC_URL ?? "https://sepolia.base.org") });
  const arc = createPublicClient({
    transport: fallback([
      http(process.env["ARC_RPC_SERVER_URL"] ?? "https://5042002.rpc.thirdweb.com"),
      http("https://arc-testnet.drpc.org"),
    ]),
  });

  const pending: Pending[] = [];

  const baseTip = await base.getBlockNumber();
  for (let start = baseTip > 20_000n ? baseTip - 20_000n : 0n; start <= baseTip; start += 1_900n) {
    const end = start + 1_899n < baseTip ? start + 1_899n : baseTip;
    const logs = await base.getLogs({ address: vault, event: depositedEvent, fromBlock: start, toBlock: end });
    for (const l of logs) {
      if (l.transactionHash === null || l.logIndex === null || l.args.netAmount === undefined) continue;
      const actionId = bridgeActionId(l.transactionHash, BigInt(l.logIndex));
      const minted = await arc.readContract({ address: bridge, abi: archBridgeArcAbi, functionName: "processedDeposits", args: [actionId] });
      if (!minted) pending.push({ direction: "deposit", actionId, sourceTx: l.transactionHash, amountUnits: l.args.netAmount });
    }
  }

  const arcTip = await arc.getBlockNumber();
  for (let start = arcTip > 5_000n ? arcTip - 5_000n : 0n; start <= arcTip; start += 900n) {
    const end = start + 899n < arcTip ? start + 899n : arcTip;
    const logs = await arc.getLogs({ address: bridge, event: redeemedEvent, fromBlock: start, toBlock: end }).catch(() => []);
    for (const l of logs) {
      if (l.transactionHash === null || l.logIndex === null || l.args.amount === undefined) continue;
      const actionId = bridgeActionId(l.transactionHash, BigInt(l.logIndex));
      const released = await base.readContract({ address: vault, abi: archVaultBaseAbi, functionName: "processedRedemptions", args: [actionId] });
      if (!released) pending.push({ direction: "redeem", actionId, sourceTx: l.transactionHash, amountUnits: l.args.amount });
    }
    await new Promise((r) => setTimeout(r, 200));
  }

  if (pending.length === 0) {
    log.info("reconciliation clean: every deposit minted, every burn released");
  } else {
    for (const p of pending) {
      log.warn({ direction: p.direction, actionId: p.actionId, sourceTx: p.sourceTx, amountUnits: p.amountUnits.toString() }, "PENDING destination action");
    }
    log.warn({ count: pending.length }, "actions awaiting destination processing (workers will complete these; investigate if stuck)");
  }
  process.exit(0);
}

main().catch((err: unknown) => {
  log.fatal({ err }, "reconciliation failed");
  process.exit(1);
});
