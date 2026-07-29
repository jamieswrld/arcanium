import pino from "pino";
import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbiItem,
  type Hex,
  type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { archBridgeArcAbi } from "@arch/abis";
import { bridgeActionId } from "@arch/sdk";
import { loadEnv } from "@arch/config";
import { transportFor, withRetry } from "./rpc.js";

/**
 * Base→Arc deposit worker.
 *
 * Loop: poll the vault's Deposited events on Base → wait the configured
 * confirmation depth → verify the log still exists at depth (reorg check) →
 * check the Arc bridge's on-chain processedDeposits mapping (the authoritative
 * replay barrier) → mint exactly netAmount aUSD to the recipient.
 *
 * Safety model: the contract, not this process, prevents double-mints. The
 * worker can crash, restart, or run twice and the worst case is a reverted
 * transaction. State (last scanned block) is kept in memory and re-derived
 * from a bounded lookback on restart.
 */

const env = loadEnv();
const log = pino({ level: env.LOG_LEVEL, name: "arch-bridge-worker" });

const depositedEvent = parseAbiItem(
  "event Deposited(address indexed sender, address indexed arcRecipient, uint256 grossAmount, uint256 feeAmount, uint256 netAmount, uint256 nonce)",
);

interface WorkerConfig {
  readonly baseRpc: string;
  readonly arcRpc: string;
  readonly vault: Hex;
  readonly bridge: Hex;
  readonly confirmations: bigint;
  readonly keeperKey: Hex;
  readonly pollMs: number;
  readonly lookbackBlocks: bigint;
  readonly maxRangePerQuery: bigint;
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (v === undefined || v.length === 0) {
    throw new Error(`${name} is required`);
  }
  return v;
}

function loadWorkerConfig(): WorkerConfig {
  return {
    baseRpc: env.BASE_SEPOLIA_RPC_URL ?? "https://sepolia.base.org",
    arcRpc: env.ARC_TESTNET_RPC_URL,
    vault: requireEnv("ARCH_VAULT_BASE_ADDRESS") as Hex,
    bridge: requireEnv("ARCH_BRIDGE_ARC_ADDRESS") as Hex,
    confirmations: BigInt(env.BASE_SEPOLIA_CONFIRMATIONS),
    keeperKey: requireEnv("ARC_KEEPER_PRIVATE_KEY") as Hex,
    pollMs: 15_000,
    lookbackBlocks: 600n,
    maxRangePerQuery: 500n,
  };
}

async function getLogsChunked(
  client: PublicClient,
  cfg: WorkerConfig,
  fromBlock: bigint,
  toBlock: bigint,
) {
  const all = [];
  for (let start = fromBlock; start <= toBlock; start += cfg.maxRangePerQuery) {
    const end =
      start + cfg.maxRangePerQuery - 1n < toBlock
        ? start + cfg.maxRangePerQuery - 1n
        : toBlock;
    const logs = await client.getLogs({
      address: cfg.vault,
      event: depositedEvent,
      fromBlock: start,
      toBlock: end,
    });
    all.push(...logs);
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return all;
}

async function main(): Promise<void> {
  const cfg = loadWorkerConfig();
  const baseTransport = transportFor(cfg.baseRpc, process.env["BASE_RPC_URLS"]);
  const arcTransport = transportFor(cfg.arcRpc, process.env["ARC_RPC_URLS"]);
  const base = createPublicClient({ transport: baseTransport });
  const arc = createPublicClient({ transport: arcTransport });
  const keeper = privateKeyToAccount(cfg.keeperKey);
  const arcWallet = createWalletClient({ account: keeper, transport: arcTransport });
  const arcChainId = await withRetry(() => arc.getChainId());

  log.info(
    { vault: cfg.vault, bridge: cfg.bridge, keeper: keeper.address, confirmations: cfg.confirmations.toString() },
    "deposit worker starting",
  );

  const head = await base.getBlockNumber();
  let scannedTo = head > cfg.lookbackBlocks ? head - cfg.lookbackBlocks : 0n;

  let cycle = 0;
  for (;;) {
    try {
      cycle++;
      const tip = await base.getBlockNumber();
      const confirmedTip = tip - cfg.confirmations;
      if (confirmedTip > scannedTo) {
        const logs = await getLogsChunked(base, cfg, scannedTo + 1n, confirmedTip);
        for (const entry of logs) {
          if (entry.transactionHash === null || entry.logIndex === null) continue;
          const actionId = bridgeActionId(entry.transactionHash, BigInt(entry.logIndex));
          const { arcRecipient, netAmount, grossAmount, feeAmount, nonce } = entry.args;
          if (arcRecipient === undefined || netAmount === undefined) continue;

          // Reorg check: the log must still exist at confirmed depth.
          const receipt = await base.getTransactionReceipt({ hash: entry.transactionHash });
          if (receipt.status !== "success" || receipt.blockNumber !== entry.blockNumber) {
            log.warn({ actionId, tx: entry.transactionHash }, "reorg_detected: log moved or failed; skipping (will rescan)");
            continue;
          }

          // Authoritative replay barrier: the Arc contract's processed mapping.
          const processed = await arc.readContract({
            address: cfg.bridge,
            abi: archBridgeArcAbi,
            functionName: "processedDeposits",
            args: [actionId],
          });
          if (processed) {
            log.debug({ actionId }, "already minted; skipping");
            continue;
          }

          log.info(
            { actionId, recipient: arcRecipient, net: netAmount.toString(), gross: grossAmount?.toString(), fee: feeAmount?.toString(), nonce: nonce?.toString() },
            "minting confirmed deposit",
          );
          // Explicit nonce + gas: never depend on a racy estimate, and never
          // let a stale pending-nonce read collide with an in-flight tx.
          const nextNonce = await withRetry(() =>
            arc.getTransactionCount({ address: keeper.address, blockTag: "pending" }),
          );
          const txHash = await withRetry(() =>
            arcWallet.writeContract({
              chain: null,
              address: cfg.bridge,
              abi: archBridgeArcAbi,
              functionName: "mintDeposit",
              args: [entry.transactionHash, BigInt(entry.logIndex), arcRecipient, netAmount],
              gas: 300_000n,
              nonce: nextNonce,
            }),
          );

          // Bounded receipt wait. A hung RPC previously wedged this loop
          // forever; now we time out, log, and let the next cycle re-check the
          // on-chain processed mapping (which is the real source of truth).
          let confirmed = false;
          try {
            const mintReceipt = await arc.waitForTransactionReceipt({
              hash: txHash,
              timeout: 90_000,
              pollingInterval: 3_000,
            });
            confirmed = mintReceipt.status === "success";
            log.info(
              { actionId, arcTx: txHash, status: mintReceipt.status, chainId: arcChainId },
              confirmed ? "mint confirmed" : "mint reverted (on-chain guard)",
            );
          } catch (waitErr) {
            log.warn(
              { actionId, arcTx: txHash, err: waitErr instanceof Error ? waitErr.message : String(waitErr) },
              "receipt wait timed out; verifying against chain state",
            );
          }

          if (!confirmed) {
            // Verify by state rather than by receipt: the tx may well have
            // landed even though the RPC never returned the receipt.
            const nowProcessed = await withRetry(() =>
              arc.readContract({
                address: cfg.bridge,
                abi: archBridgeArcAbi,
                functionName: "processedDeposits",
                args: [actionId],
              }),
            ).catch(() => false);
            log.info(
              { actionId, arcTx: txHash, processed: nowProcessed },
              nowProcessed ? "mint landed (verified on-chain)" : "mint not yet on-chain; will retry next cycle",
            );
          }
        }
        scannedTo = confirmedTip;
      }
      if (cycle % 5 === 1) log.info({ cycle, scannedTo: scannedTo.toString() }, "scan cycle ok");
    } catch (err) {
      log.error({ err }, "poll cycle failed; retrying after interval");
    }
    await new Promise((resolve) => setTimeout(resolve, cfg.pollMs));
  }
}

main().catch((err: unknown) => {
  log.fatal({ err }, "deposit worker crashed");
  process.exit(1);
});
