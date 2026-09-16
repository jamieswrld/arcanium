import { privateKeyToAccount } from "viem/accounts";
import { createPublicClient, http, fallback } from "viem";

/**
 * Which key in .env controls the splitter/distributor owner?
 * Derives addresses only — never prints or logs a key.
 */
const OWNER = "0x8fA45d6cA2D97fcfa7496C4D34647EC3CBB48764".toLowerCase();
const SPLITTER = "0x1E8334F3009EC6a0fBF77a1Faaa26B1265f560eF";
const USDC = "0x3600000000000000000000000000000000000000";

const NAMES = [
  "DEPLOYER_PRIVATE_KEY",
  "ARC_KEEPER_PRIVATE_KEY",
  "BASE_KEEPER_PRIVATE_KEY",
  "RELAYER_PRIVATE_KEY",
];

let match = null;
for (const name of NAMES) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") {
    console.log(`  ${name.padEnd(26)} not set`);
    continue;
  }
  try {
    const key = raw.trim().startsWith("0x") ? raw.trim() : `0x${raw.trim()}`;
    const addr = privateKeyToAccount(key).address;
    const hit = addr.toLowerCase() === OWNER;
    console.log(`  ${name.padEnd(26)} -> ${addr} ${hit ? "  *** CONTROLS THE OWNER ***" : ""}`);
    if (hit) match = name;
  } catch {
    console.log(`  ${name.padEnd(26)} unreadable`);
  }
}
console.log("\n  owner controllable from .env:", match ?? "NO — an external wallet owns it");

const c = createPublicClient({
  transport: fallback(
    ["https://rpc.arc-scan.org", "https://rpc.blockdaemon.mainnet.arc.io"].map((u) =>
      http(u, { timeout: 15_000, retryCount: 1 }),
    ),
  ),
});
const erc = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
];
const bal = await c
  .readContract({ address: USDC, abi: erc, functionName: "balanceOf", args: [SPLITTER] })
  .catch(() => null);
console.log(
  "  undistributed USDC sitting in the splitter:",
  bal === null ? "unreadable" : `${(Number(bal) / 1e6).toFixed(6)} USDC`,
);
