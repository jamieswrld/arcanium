import pino from "pino";
import {
  createPublicClient,
  createWalletClient,
  fallback,
  http,
  parseAbi,
  formatUnits,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

/**
 * Fee collector. Periodically calls distribute() on every launch pool so fees
 * move without anyone poking them:
 *
 *   STANDARD — creators get paid automatically.
 *   DIVIUM   — rewards accrue to holders automatically (they still claim,
 *              which is the only scalable way to pay N holders).
 *   ARCANE   — buy-and-burn fires automatically; nothing to claim, ever.
 *
 * Gas discipline: each pool is simulated first and skipped unless it has
 * collectable fees above a floor, so we never burn gas on empty collections.
 */

const log = pino({ level: process.env["LOG_LEVEL"] ?? "info", name: "arch-collector" });

const req = (n: string): string => {
  const v = process.env[n];
  if (v === undefined || v === "") throw new Error(`${n} required`);
  return v;
};

const RPC = process.env["ARC_RPC_SERVER_URL"] ?? "https://rpc.blockdaemon.mainnet.arc.io";
const FACTORY = req("ARCH_LAUNCHPAD_FACTORY_ADDRESS") as Hex;
const LEGACY_FACTORY = process.env["ARCH_LEGACY_FACTORY_ADDRESS"] as Hex | undefined;
const DISTRIBUTOR = req("ARCH_MODE_DISTRIBUTOR_ADDRESS") as Hex;
const VAULT = req("ARCH_LIQUIDITY_VAULT_ADDRESS") as Hex;
const KEY = req("COLLECTOR_PRIVATE_KEY") as Hex;

/** Skip pools with less than this in collectable quote fees (6d units). */
const MIN_QUOTE_FEES = BigInt(process.env["COLLECTOR_MIN_FEES"] ?? "10000"); // 0.01 USDC
const INTERVAL_MS = Number(process.env["COLLECTOR_INTERVAL_MS"] ?? "3600000"); // hourly

const chain = {
  id: 5042,
  name: "arc",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
} as const;

const account = privateKeyToAccount(KEY);
const transport = fallback([http(RPC, { timeout: 20_000, retryCount: 2 })]);
const pub = createPublicClient({ chain, transport });
const wallet = createWalletClient({ account, chain, transport });

const factoryAbi = parseAbi([
  "function allTokensLength() view returns (uint256)",
  "function allTokens(uint256) view returns (address)",
  "function launches(address) view returns (address token, address creator, address pairToken, address pool, uint256 positionId)",
]);
const vaultAbi = parseAbi(["function collectFees(uint256) returns (uint256, uint256)"]);
const distAbi = parseAbi(["function distribute(address)", "function modeOf(address) view returns (uint8)"]);

const MODE_NAMES = ["standard", "divium", "arcane"] as const;

async function tokensOf(factory: Hex): Promise<Hex[]> {
  const count = await pub.readContract({ address: factory, abi: factoryAbi, functionName: "allTokensLength" }).catch(() => 0n);
  const out: Hex[] = [];
  for (let i = 0n; i < count; i++) {
    const t = await pub.readContract({ address: factory, abi: factoryAbi, functionName: "allTokens", args: [i] }).catch(() => null);
    if (t !== null) out.push(t);
  }
  return out;
}

/** Collectable quote-side fees, via simulation (no state change). */
async function pendingQuoteFees(factory: Hex, token: Hex): Promise<bigint> {
  const [launched, , pairToken, , positionId] = await pub.readContract({
    address: factory, abi: factoryAbi, functionName: "launches", args: [token],
  });
  if (launched === "0x0000000000000000000000000000000000000000") return 0n;
  const sim = await pub
    .simulateContract({ address: VAULT, abi: vaultAbi, functionName: "collectFees", args: [positionId], account: DISTRIBUTOR })
    .then((r) => r.result as readonly [bigint, bigint])
    .catch(() => [0n, 0n] as const);
  const tokenIsToken0 = token.toLowerCase() < pairToken.toLowerCase();
  return tokenIsToken0 ? sim[1] : sim[0];
}

async function cycle(): Promise<void> {
  const factories: Hex[] = [FACTORY, ...(LEGACY_FACTORY !== undefined ? [LEGACY_FACTORY] : [])];
  const seen = new Set<string>();
  let collected = 0;
  let skipped = 0;

  for (const factory of factories) {
    for (const token of await tokensOf(factory)) {
      const key = token.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);

      const pending = await pendingQuoteFees(factory, token).catch(() => 0n);
      if (pending < MIN_QUOTE_FEES) { skipped += 1; continue; }

      const mode = await pub.readContract({ address: DISTRIBUTOR, abi: distAbi, functionName: "modeOf", args: [token] }).catch(() => 0);
      try {
        const nonce = await pub.getTransactionCount({ address: account.address });
        const hash = await wallet.writeContract({
          address: DISTRIBUTOR, abi: distAbi, functionName: "distribute", args: [token], nonce, gas: 3_000_000n,
        });
        const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 90_000 });
        collected += 1;
        log.info(
          { token, mode: MODE_NAMES[Number(mode)] ?? "standard", fees: formatUnits(pending, 6), status: receipt.status, hash },
          "distributed",
        );
      } catch (err) {
        log.warn({ token, err: (err as Error).message.split("\n")[0] }, "distribute failed");
      }
    }
  }

  const gas = await pub.getBalance({ address: account.address }).catch(() => 0n);
  log.info({ collected, skipped, collectorGas: formatUnits(gas, 18) }, "cycle complete");
  if (gas < 20_000_000_000_000_000n) {
    log.error({ collectorGas: formatUnits(gas, 18) }, "collector gas low — top up or collections will stop");
  }
}

async function main(): Promise<void> {
  log.info({ collector: account.address, intervalMs: INTERVAL_MS }, "fee collector starting");
  for (;;) {
    try {
      await cycle();
    } catch (err) {
      log.error({ err }, "collector cycle failed");
    }
    await new Promise((r) => setTimeout(r, INTERVAL_MS));
  }
}

main().catch((err: unknown) => {
  log.fatal({ err }, "collector crashed");
  process.exit(1);
});
