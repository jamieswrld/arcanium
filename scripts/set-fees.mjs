#!/usr/bin/env node
/**
 * Tune protocol fees (owner-only, no redeploy). Two levers:
 *   1. Launch fee   — factory.setLaunchFee(usdcUnits)      (one-time, per token)
 *   2. Trading tax  — feeDistributor.setCreatorShare(bps)  (recurring, forever)
 *      The pool charges Uniswap's 1% fee; token-side is burned; the USDC side
 *      splits creatorShare to the creator and the REST to the protocol. Lower
 *      creator share = more protocol extraction.
 *
 *   node scripts/set-fees.mjs <launchFeeUSDC> <creatorShareBps>
 *   e.g.  node scripts/set-fees.mjs 100 500      # 100 USDC fee, 5% creator / 95% protocol
 *
 * Reads the operator key from .env.mainnet (never printed).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(root, "apps/web/package.json"));
const { createPublicClient, createWalletClient, http, fallback, parseAbi, getAddress, parseUnits, formatUnits } = require("viem");
const { privateKeyToAccount } = require("viem/accounts");

const env = Object.fromEntries(
  readFileSync(join(root, ".env.mainnet"), "utf8").split(/\r?\n/)
    .filter((l) => l.includes("=") && !l.trimStart().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]),
);
const addresses = JSON.parse(readFileSync(join(root, "deployed-addresses.5042.json"), "utf8"));

const launchFeeUsdc = process.argv[2] ?? "100";
const creatorShareBps = BigInt(process.argv[3] ?? "500");
if (!/^\d+(\.\d+)?$/.test(launchFeeUsdc)) { console.error("launchFeeUSDC must be a number"); process.exit(1); }
if (creatorShareBps < 100n || creatorShareBps > 5000n) { console.error("creatorShareBps must be 100..5000 (1%..50%)"); process.exit(1); }
const launchFeeUnits = parseUnits(launchFeeUsdc, 6);

const account = privateKeyToAccount(env.DEPLOYER_PRIVATE_KEY);
const rpc = env.ARC_MAINNET_RPC_URL ?? "https://rpc.blockdaemon.mainnet.arc.io";
const chain = { id: Number(env.ARC_MAINNET_CHAIN_ID ?? "5042"), name: "arc", nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } };
const transport = fallback([http(rpc), http("https://5042.rpc.thirdweb.com")]);
const pub = createPublicClient({ chain, transport });
const wallet = createWalletClient({ account, chain, transport });

const FACTORY = getAddress(addresses.factory);
const DISTRIBUTOR = getAddress(addresses.distributor);
const facAbi = parseAbi(["function owner() view returns (address)", "function launchFee() view returns (uint256)", "function setLaunchFee(uint256)"]);
const distAbi = parseAbi(["function owner() view returns (address)", "function creatorShareBps() view returns (uint256)", "function setCreatorShare(uint256)"]);

async function main() {
  const facOwner = await pub.readContract({ address: FACTORY, abi: facAbi, functionName: "owner" });
  const distOwner = await pub.readContract({ address: DISTRIBUTOR, abi: distAbi, functionName: "owner" });
  if (getAddress(facOwner) !== getAddress(account.address)) throw new Error(`not factory owner (${facOwner})`);
  if (getAddress(distOwner) !== getAddress(account.address)) throw new Error(`not distributor owner (${distOwner})`);

  const curFee = await pub.readContract({ address: FACTORY, abi: facAbi, functionName: "launchFee" });
  const curShare = await pub.readContract({ address: DISTRIBUTOR, abi: distAbi, functionName: "creatorShareBps" });
  console.log(`launch fee : ${formatUnits(curFee, 6)} -> ${launchFeeUsdc} USDC`);
  console.log(`creator/protocol split: ${Number(curShare) / 100}% / ${100 - Number(curShare) / 100}%  ->  ${Number(creatorShareBps) / 100}% / ${100 - Number(creatorShareBps) / 100}%`);

  if (curFee !== launchFeeUnits) {
    const h = await wallet.writeContract({ address: FACTORY, abi: facAbi, functionName: "setLaunchFee", args: [launchFeeUnits] });
    console.log(`setLaunchFee tx: ${h} -> ${(await pub.waitForTransactionReceipt({ hash: h })).status}`);
  } else console.log("launch fee already set");

  if (curShare !== creatorShareBps) {
    const h = await wallet.writeContract({ address: DISTRIBUTOR, abi: distAbi, functionName: "setCreatorShare", args: [creatorShareBps] });
    console.log(`setCreatorShare tx: ${h} -> ${(await pub.waitForTransactionReceipt({ hash: h })).status}`);
  } else console.log("creator share already set");

  const newFee = await pub.readContract({ address: FACTORY, abi: facAbi, functionName: "launchFee" });
  const newShare = await pub.readContract({ address: DISTRIBUTOR, abi: distAbi, functionName: "creatorShareBps" });
  console.log(`\nNow live: launch fee ${formatUnits(newFee, 6)} USDC · protocol takes ${100 - Number(newShare) / 100}% of the 1% trading fee on every token.`);
}
main().catch((e) => { console.error("\nFAILED:", e.shortMessage || e.message); process.exit(1); });
