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
import { archVaultBaseAbi } from "@arch/abis";
import { bridgeActionId } from "@arch/sdk";
import { loadEnv } from "@arch/config";

/**
 * Arc→Base redemption worker.
 *
 * Loop: poll the bridge's Redeemed events on Arc → wait the configured Arc
 * finality depth → verify the burn log still exists → check the Base vault's
 * on-chain processedRedemptions mapping (authoritative replay barrier) →
 * release exactly the burned amount of USDC to the Base recipient.
 */

const env = loadEnv();
const log = pino({ level: env.LOG_LEVEL, name: "arch-redeem-worker" });

const redeemedEvent = parseAbiItem(
  "event Redeemed(address indexed sender, address indexed baseRecipient, uint256 amount, uint256 nonce)",
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
    confirmations: BigInt(env.ARC_TESTNET_CONFIRMATIONS),
    keeperKey: requireEnv("BASE_KEEPER_PRIVATE_KEY") as Hex,
    pollMs: 20_000,
    lookbackBlocks: 600n,
    maxRangePerQuery: 900n,
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
      address: cfg.bridge,
      event: redeemedEvent,
      fromBlock: start,
      toBlock: end,
    });
    all.push(...logs);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  return all;
}

async function main(): Promise<void> {
  const cfg = loadWorkerConfig();
  const arc = createPublicClient({ transport: http(cfg.arcRpc, { timeout: 15_000, retryCount: 2 }) });
  const base = createPublicClient({ transport: http(cfg.baseRpc, { timeout: 15_000, retryCount: 2 }) });
  const keeper = privateKeyToAccount(cfg.keeperKey);
  const baseWallet = createWalletClient({
    account: keeper,
    transport: http(cfg.baseRpc, { timeout: 15_000, retryCount: 2 }),
  });

  log.info(
    { vault: cfg.vault, bridge: cfg.bridge, keeper: keeper.address, confirmations: cfg.confirmations.toString() },
    "redemption worker starting",
  );

  const head = await arc.getBlockNumber();
  let scannedTo = head > cfg.lookbackBlocks ? head - cfg.lookbackBlocks : 0n;

  let cycle = 0;
  for (;;) {
    try {
      cycle++;
      const tip = await arc.getBlockNumber();
      const confirmedTip = tip - cfg.confirmations;
      if (confirmedTip > scannedTo) {
        const logs = await getLogsChunked(arc, cfg, scannedTo + 1n, confirmedTip);
        for (const entry of logs) {
          if (entry.transactionHash === null || entry.logIndex === null) continue;
          const actionId = bridgeActionId(entry.transactionHash, BigInt(entry.logIndex));
          const { baseRecipient, amount, nonce } = entry.args;
          if (baseRecipient === undefined || amount === undefined) continue;

          // Reorg check: the burn must still exist at confirmed depth.
          const receipt = await arc.getTransactionReceipt({ hash: entry.transactionHash });
          if (receipt.status !== "success" || receipt.blockNumber !== entry.blockNumber) {
            log.warn({ actionId, tx: entry.transactionHash }, "reorg_detected: burn log moved or failed; skipping");
            continue;
          }

          // Authoritative replay barrier: the Base vault's processed mapping.
          const processed = await base.readContract({
            address: cfg.vault,
            abi: archVaultBaseAbi,
            functionName: "processedRedemptions",
            args: [actionId],
          });
          if (processed) {
            log.debug({ actionId }, "already released; skipping");
            continue;
          }

          log.info(
            { actionId, recipient: baseRecipient, amount: amount.toString(), nonce: nonce?.toString() },
            "releasing confirmed burn",
          );
          const txHash = await baseWallet.writeContract({
            chain: null,
            address: cfg.vault,
            abi: archVaultBaseAbi,
            functionName: "release",
            args: [entry.transactionHash, BigInt(entry.logIndex), baseRecipient, amount],
            gas: 250_000n,
          });
          const releaseReceipt = await base.waitForTransactionReceipt({ hash: txHash });
          log.info(
            { actionId, baseTx: txHash, status: releaseReceipt.status },
            releaseReceipt.status === "success" ? "release confirmed" : "release reverted (on-chain guard)",
          );
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
  log.fatal({ err }, "redemption worker crashed");
  process.exit(1);
});
