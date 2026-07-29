import pino from "pino";
import { createPublicClient, fallback, http, parseAbi, formatUnits, formatEther, type Hex } from "viem";
import { loadEnv } from "@arch/config";

/**
 * Arcanium health monitor. Every cycle it checks the things that, if they
 * silently break, make the product look broken or unsafe:
 *   - solvency: Base reserve must always cover aUSD supply
 *   - keeper Arc gas: pays for every mint — empty = deposits stop minting
 *   - keeper Base ETH: pays for every release — empty = redemptions stall
 *   - gas station inventory: what users buy to transact on Arc
 * Warnings are logged loudly and, if ALERT_WEBHOOK_URL is set (Discord/Slack
 * style), posted there so a human is paged before users notice.
 */

const env = loadEnv();
const log = pino({ level: env.LOG_LEVEL, name: "arch-monitor" });

const req = (n: string): string => {
  const v = process.env[n];
  if (v === undefined || v.length === 0) throw new Error(`${n} required`);
  return v;
};

const VAULT = req("ARCH_VAULT_BASE_ADDRESS") as Hex;
const AUSD = req("ARCH_USD_ADDRESS") as Hex;
const GAS_STATION = process.env["ARCH_GAS_STATION_ADDRESS"] as Hex | undefined;
const KEEPER = req("MONITOR_KEEPER_ADDRESS") as Hex;
const WEBHOOK = process.env["ALERT_WEBHOOK_URL"];

// Thresholds (6-decimal / wei). Alert when balances dip below these.
const MIN_ARC_GAS = BigInt(process.env["ALERT_MIN_ARC_GAS_WEI"] ?? "50000000000000000"); // 0.05 native USDC
const MIN_BASE_ETH = BigInt(process.env["ALERT_MIN_BASE_ETH_WEI"] ?? "2000000000000000"); // 0.002 ETH
const MIN_GAS_INV = BigInt(process.env["ALERT_MIN_GAS_INV_WEI"] ?? "30000000000000000"); // 0.03 native USDC
const POLL_MS = Number(process.env["MONITOR_POLL_MS"] ?? "120000");

const base = createPublicClient({ transport: http(env.BASE_SEPOLIA_RPC_URL ?? "https://mainnet.base.org", { timeout: 15_000, retryCount: 2 }) });
const arc = createPublicClient({
  transport: fallback([
    http(process.env["ARC_RPC_SERVER_URL"] ?? env.ARC_TESTNET_RPC_URL, { timeout: 15_000, retryCount: 2 }),
    http("https://5042.rpc.thirdweb.com", { timeout: 15_000, retryCount: 2 }),
  ]),
});

const vaultAbi = parseAbi(["function totalReserve() view returns (uint256)"]);
const supplyAbi = parseAbi(["function totalSupply() view returns (uint256)"]);

const firing = new Set<string>();

async function alert(key: string, severity: "warn" | "critical", message: string): Promise<void> {
  if (firing.has(key)) return; // de-dupe until it clears
  firing.add(key);
  log[severity === "critical" ? "error" : "warn"]({ key }, message);
  if (WEBHOOK !== undefined) {
    await fetch(WEBHOOK, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: `${severity === "critical" ? "🔴" : "🟠"} **Arcanium**: ${message}` }),
    }).catch((e: unknown) => log.error({ e }, "webhook post failed"));
  }
}

function clear(key: string): void {
  if (firing.delete(key)) log.info({ key }, "condition cleared");
}

async function cycle(): Promise<void> {
  const [reserve, supply, arcGas, baseEth, gasInv] = await Promise.all([
    base.readContract({ address: VAULT, abi: vaultAbi, functionName: "totalReserve" }),
    arc.readContract({ address: AUSD, abi: supplyAbi, functionName: "totalSupply" }),
    arc.getBalance({ address: KEEPER }),
    base.getBalance({ address: KEEPER }),
    GAS_STATION !== undefined ? arc.getBalance({ address: GAS_STATION }) : Promise.resolve(0n),
  ]);

  // Solvency is the crown jewel — reserve must always cover supply.
  if (reserve < supply) {
    await alert("solvency", "critical", `INSOLVENT: reserve ${formatUnits(reserve, 6)} < supply ${formatUnits(supply, 6)} USDC`);
  } else clear("solvency");

  if (arcGas < MIN_ARC_GAS) {
    await alert("arc-gas", "warn", `Keeper Arc gas low: ${formatUnits(arcGas, 18)} USDC — mints will stop when it hits zero`);
  } else clear("arc-gas");

  if (baseEth < MIN_BASE_ETH) {
    await alert("base-eth", "warn", `Keeper Base ETH low: ${formatEther(baseEth)} ETH — releases will stall`);
  } else clear("base-eth");

  if (GAS_STATION !== undefined && gasInv < MIN_GAS_INV) {
    await alert("gas-inv", "warn", `Gas station inventory low: ${formatUnits(gasInv, 18)} USDC — users can't buy gas`);
  } else clear("gas-inv");

  log.info(
    {
      reserve: formatUnits(reserve, 6),
      supply: formatUnits(supply, 6),
      solvent: reserve >= supply,
      keeperArcGas: formatUnits(arcGas, 18),
      keeperBaseEth: formatEther(baseEth),
      gasStationInv: formatUnits(gasInv, 18),
    },
    "health",
  );
}

async function main(): Promise<void> {
  log.info({ webhook: WEBHOOK !== undefined }, "monitor starting");
  for (;;) {
    try {
      await cycle();
    } catch (err) {
      log.error({ err }, "monitor cycle failed");
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

main().catch((err: unknown) => {
  log.fatal({ err }, "monitor crashed");
  process.exit(1);
});
