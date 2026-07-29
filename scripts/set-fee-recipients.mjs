#!/usr/bin/env node
/**
 * Set the protocol fee recipients on both ArchFeeSplitter deployments and
 * audit that every protocol fee stream routes to them.
 *
 * Usage:
 *   node scripts/set-fee-recipients.mjs audit
 *   node scripts/set-fee-recipients.mjs set 0xA...,0xB...,0xC...,0xD...,0xE...,0xF...,0xG...
 *   node scripts/set-fee-recipients.mjs set <addresses> --weights 4000,1000,1000,1000,1000,1000,1000
 *
 * Reads DEPLOYER_PRIVATE_KEY and contract addresses from .env at the repo root.
 * Weights are bps and must sum to 10000; default = 4000 + 6x1000.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(join(dirname(fileURLToPath(import.meta.url)), "..", "apps", "web", "package.json"));
const { createPublicClient, createWalletClient, http } = require("viem");
const { privateKeyToAccount } = require("viem/accounts");

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const env = Object.fromEntries(
  readFileSync(join(root, ".env"), "utf8")
    .split(/\r?\n/)
    .filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);

const splitterAbi = [
  { type: "function", name: "setRecipients", stateMutability: "nonpayable", inputs: [{ type: "address[]" }, { type: "uint256[]" }], outputs: [] },
  { type: "function", name: "recipientCount", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "recipients", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "address" }] },
  { type: "function", name: "weightsBps", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "uint256" }] },
];
const pointerAbi = [
  { type: "function", name: "treasury", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "launchFeeTreasury", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "protocolTreasury", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
];

const chains = {
  arc: {
    rpc: env.ARC_RPC_SERVER_URL ?? "https://5042002.rpc.thirdweb.com",
    id: 5042002,
    splitter: env.ARCH_FEE_SPLITTER_ARC_ADDRESS,
  },
  base: {
    rpc: env.BASE_SEPOLIA_RPC_URL ?? "https://sepolia.base.org",
    id: 84532,
    splitter: env.ARCH_FEE_SPLITTER_BASE_ADDRESS,
  },
};

async function audit() {
  for (const [label, c] of Object.entries(chains)) {
    const pub = createPublicClient({ transport: http(c.rpc) });
    console.log(`\n== ${label} splitter ${c.splitter}`);
    const count = await pub.readContract({ address: c.splitter, abi: splitterAbi, functionName: "recipientCount" });
    for (let i = 0n; i < count; i++) {
      const [addr, weight] = await Promise.all([
        pub.readContract({ address: c.splitter, abi: splitterAbi, functionName: "recipients", args: [i] }),
        pub.readContract({ address: c.splitter, abi: splitterAbi, functionName: "weightsBps", args: [i] }),
      ]);
      console.log(`  ${(Number(weight) / 100).toFixed(1).padStart(5)}%  ${addr}`);
    }
  }
  const arcPub = createPublicClient({ transport: http(chains.arc.rpc) });
  const basePub = createPublicClient({ transport: http(chains.base.rpc) });
  console.log("\n== fee stream routing");
  const bridgeTreasury = await basePub.readContract({ address: env.ARCH_VAULT_BASE_ADDRESS, abi: pointerAbi, functionName: "treasury" });
  const launchTreasury = await arcPub.readContract({ address: env.ARCH_LAUNCHPAD_FACTORY_ADDRESS, abi: pointerAbi, functionName: "launchFeeTreasury" });
  const tradingTreasury = await arcPub.readContract({ address: env.ARCH_FEE_DISTRIBUTOR_ADDRESS, abi: pointerAbi, functionName: "protocolTreasury" });
  const check = (name, actual, expected) =>
    console.log(`  ${actual.toLowerCase() === expected.toLowerCase() ? "OK " : "MISROUTED"}  ${name}: ${actual}`);
  check("bridge deposit fees (Base vault)", bridgeTreasury, chains.base.splitter);
  check("launch fees (factory)", launchTreasury, chains.arc.splitter);
  check("trading fees 70% share (distributor)", tradingTreasury, chains.arc.splitter);
  console.log("  note: gas-station margins accrue in the station; withdraw to the Arc splitter via withdrawCollectedAusd/withdrawInventory.");
}

async function set(addressesCsv, weightsCsv) {
  const recipients = addressesCsv.split(",").map((a) => a.trim());
  const weights = (weightsCsv ?? "4000," + Array(recipients.length - 1).fill("1000").join(","))
    .split(",")
    .map((w) => BigInt(w.trim()));
  if (recipients.some((a) => !/^0x[0-9a-fA-F]{40}$/.test(a))) throw new Error("invalid address in list");
  if (weights.reduce((a, b) => a + b, 0n) !== 10000n) throw new Error("weights must sum to 10000 bps");
  if (weights.length !== recipients.length) throw new Error("weights/addresses length mismatch");

  const account = privateKeyToAccount(env.DEPLOYER_PRIVATE_KEY);
  for (const [label, c] of Object.entries(chains)) {
    const pub = createPublicClient({ transport: http(c.rpc) });
    const wallet = createWalletClient({ account, transport: http(c.rpc) });
    const hash = await wallet.writeContract({
      chain: { id: c.id, name: label, nativeCurrency: { name: "x", symbol: "x", decimals: 18 }, rpcUrls: { default: { http: [c.rpc] } } },
      address: c.splitter,
      abi: splitterAbi,
      functionName: "setRecipients",
      args: [recipients, weights],
    });
    const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 120000 });
    console.log(`${label}: setRecipients ${receipt.status} (${hash})`);
  }
  await audit();
}

const [mode, addresses, weightsFlag, weightsValue] = process.argv.slice(2);
if (mode === "audit") {
  audit().catch((e) => { console.error(e.message); process.exit(1); });
} else if (mode === "set" && addresses !== undefined) {
  set(addresses, weightsFlag === "--weights" ? weightsValue : undefined)
    .catch((e) => { console.error(e.message); process.exit(1); });
} else {
  console.log("usage: node scripts/set-fee-recipients.mjs audit | set <addr1,...,addrN> [--weights w1,...,wN]");
  process.exit(1);
}
