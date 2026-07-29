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
    lookbackBlocks: 10_000n,
    maxRangePerQuery: 1_900n,
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
  const base = createPublicClient({ transport: http(cfg.baseRpc) });
  const arc = createPublicClient({ transport: http(cfg.arcRpc) });
  const keeper = privateKeyToAccount(cfg.keeperKey);
  const arcWallet = createWalletClient({
    account: keeper,
    transport: http(cfg.arcRpc),
  });
  const arcChainId = await arc.getChainId();

  log.info(
    { vault: cfg.vault, bridge: cfg.bridge, keeper: keeper.address, confirmations: cfg.confirmations.toString() },
    "deposit worker starting",
  );

  const head = await base.getBlockNumber();
  let scannedTo = head > cfg.lookbackBlocks ? head - cfg.lookbackBlocks : 0n;

  for (;;) {
    try {
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
          const txHash = await arcWallet.writeContract({
            chain: null,
            address: cfg.bridge,
            abi: archBridgeArcAbi,
            functionName: "mintDeposit",
            args: [entry.transactionHash, BigInt(entry.logIndex), arcRecipient, netAmount],
          });
          const mintReceipt = await arc.waitForTransactionReceipt({ hash: txHash });
          log.info(
            { actionId, arcTx: txHash, status: mintReceipt.status, chainId: arcChainId },
            mintReceipt.status === "success" ? "mint confirmed" : "mint reverted (on-chain guard)",
          );
        }
        scannedTo = confirmedTip;
      }
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
