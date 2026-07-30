#!/usr/bin/env node
/**
 * Deploy ArchBridgeRouter (CCTP front door with the protocol's flat fee) on
 * Base and Arc. Fee: 2% to the big fee wallet. Writes addresses into
 * deployed-addresses.5042.json (bridgeRouterBase / bridgeRouterArc).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(root, "apps/web/package.json"));
const { createPublicClient, createWalletClient, http, getAddress, parseAbi, formatUnits } = require("viem");
const { base } = require("viem/chains");
const { privateKeyToAccount } = require("viem/accounts");

const env = Object.fromEntries(
  readFileSync(join(root, ".env.mainnet"), "utf8").split(/\r?\n/)
    .filter((l) => l.includes("=") && !l.trimStart().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]),
);
const addrsPath = join(root, "deployed-addresses.5042.json");
const addrs = JSON.parse(readFileSync(addrsPath, "utf8"));

const account = privateKeyToAccount(env.DEPLOYER_PRIVATE_KEY);
const TM = "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d";
const TREASURY = getAddress(env.FEE_RECIPIENTS.split(",")[0].trim()); // big fee wallet (40%)
const FEE_BPS = 200n; // 2%

const art = JSON.parse(readFileSync(join(root, "packages/contracts/out/ArchBridgeRouter.sol/ArchBridgeRouter.json"), "utf8"));

async function deployOn(label, chain, rpc, usdc) {
  const pub = createPublicClient({ chain, transport: http(rpc, { timeout: 20_000 }) });
  const wallet = createWalletClient({ account, chain, transport: http(rpc, { timeout: 20_000 }) });
  const nonce = await pub.getTransactionCount({ address: account.address });
  const hash = await wallet.deployContract({
    abi: art.abi, bytecode: art.bytecode.object,
    args: [usdc, TM, TREASURY, FEE_BPS, account.address],
    nonce, gas: 1_800_000n,
  });
  const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
  if (receipt.status !== "success" || receipt.contractAddress == null) throw new Error(`${label} deploy failed (${hash})`);
  console.log(`${label} router: ${receipt.contractAddress}`);
  // verify config
  const abi = parseAbi(["function feeBps() view returns (uint256)", "function treasury() view returns (address)"]);
  const [fee, treas] = await Promise.all([
    pub.readContract({ address: receipt.contractAddress, abi, functionName: "feeBps" }),
    pub.readContract({ address: receipt.contractAddress, abi, functionName: "treasury" }),
  ]);
  console.log(`  feeBps=${fee} treasury=${treas}`);
  if (fee !== FEE_BPS || getAddress(treas) !== TREASURY) throw new Error("config mismatch");
  return getAddress(receipt.contractAddress);
}

async function main() {
  console.log(`treasury (big fee wallet): ${TREASURY}\n`);
  const arcChain = { id: 5042, name: "arc", nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 }, rpcUrls: { default: { http: [env.ARC_MAINNET_RPC_URL] } } };
  const baseRpc = "https://base-mainnet.infura.io/v3/49e8d9d19fec4a749d7f1e4ca8792977";

  const arcPub = createPublicClient({ chain: arcChain, transport: http(env.ARC_MAINNET_RPC_URL) });
  console.log(`arc gas: ${formatUnits(await arcPub.getBalance({ address: account.address }), 18)} USDC`);

  addrs.bridgeRouterBase = await deployOn("Base", base, baseRpc, "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
  addrs.bridgeRouterArc = await deployOn("Arc", arcChain, env.ARC_MAINNET_RPC_URL, env.ARC_MAINNET_USDC_ADDRESS);
  writeFileSync(addrsPath, JSON.stringify(addrs, null, 2) + "\n");
  console.log("\naddress book updated.");
}

main().catch((e) => { console.error("FAILED:", e.shortMessage || e.message); process.exit(1); });
