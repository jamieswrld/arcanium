#!/usr/bin/env node
/**
 * Fund the Arc gas station's native-USDC inventory.
 *
 *   node scripts/fund-gas-station.mjs <amountUsdc>
 *   e.g.  node scripts/fund-gas-station.mjs 100      # stock $100 of gas
 *
 * On Arc, native gas IS USDC (18-decimal native view). The gas station has a
 * `receive() payable` that credits inventory, so funding is just a native
 * value transfer to the station address.
 *
 * WHERE THE NATIVE USDC COMES FROM: today, native USDC on chain 5042 is
 * Circle-gated (Arc mainnet is pre-release; public CCTP mint is not open, and
 * third-party bridges to 5042 mainnet can lose funds). Do NOT buy it from
 * Envelope's gas station at ~175x. The intended flow, once OFFICIAL Arc
 * mainnet opens and CCTP mint is public:
 *   1. Burn USDC on Base via Circle CCTP (TokenMessenger.depositForBurn) to the
 *      Arc domain, using the addresses Circle publishes at mainnet launch.
 *   2. Redeem the Iris attestation on Arc (MessageTransmitter.receiveMessage)
 *      to mint native USDC to the deployer at ~1:1 (only network fees).
 *   3. Run THIS script to move that native USDC into the gas station.
 * Step 3 is the only part that needs no external addresses — it works the
 * moment the deployer holds native USDC, however it was obtained.
 *
 * Reads the operator key from .env.mainnet (never printed).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { createPublicClient, createWalletClient, http, formatUnits, parseUnits } = require("viem");
const { privateKeyToAccount } = require("viem/accounts");

const env = Object.fromEntries(
  readFileSync(join(root, ".env.mainnet"), "utf8").split(/\r?\n/)
    .filter((l) => l.includes("=") && !l.trimStart().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]),
);

const amountArg = process.argv[2];
if (amountArg === undefined || !/^\d+(\.\d+)?$/.test(amountArg)) {
  console.error("usage: node scripts/fund-gas-station.mjs <amountUsdc>   e.g. 100");
  process.exit(1);
}
// Native USDC on Arc uses the 18-decimal native view.
const value = parseUnits(amountArg, 18);

const addresses = JSON.parse(readFileSync(join(root, "deployed-addresses.5042.json"), "utf8"));
const STATION = addresses.gasStation;
if (STATION === undefined) { console.error("gasStation missing from deployed-addresses.5042.json"); process.exit(1); }

const account = privateKeyToAccount(env.DEPLOYER_PRIVATE_KEY);
const rpc = env.ARC_MAINNET_RPC_URL ?? "https://5042.rpc.thirdweb.com";
const chain = { id: Number(env.ARC_MAINNET_CHAIN_ID ?? "5042"), name: "arc", nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } };
const arc = createPublicClient({ chain, transport: http(rpc) });
const wallet = createWalletClient({ account, chain, transport: http(rpc) });

async function main() {
  const bal = await arc.getBalance({ address: account.address });
  console.log(`operator      : ${account.address}`);
  console.log(`native balance: ${formatUnits(bal, 18)} USDC`);
  console.log(`gas station   : ${STATION}`);
  console.log(`funding amount: ${amountArg} USDC (${value} wei)`);

  if (bal < value) {
    console.error(`\nInsufficient native USDC: have ${formatUnits(bal, 18)}, need ${amountArg} (+gas). See header for how to acquire it via CCTP once mainnet opens.`);
    process.exit(1);
  }

  const before = await arc.getBalance({ address: STATION });
  const hash = await wallet.sendTransaction({ to: STATION, value });
  console.log(`\ntx: ${hash}`);
  const receipt = await arc.waitForTransactionReceipt({ hash });
  const after = await arc.getBalance({ address: STATION });
  console.log(`status: ${receipt.status}`);
  console.log(`station inventory: ${formatUnits(before, 18)} -> ${formatUnits(after, 18)} USDC`);
}

main().catch((e) => { console.error(e); process.exit(1); });
