#!/usr/bin/env node
/**
 * Redeploy the launchpad factory stack on Arc mainnet with the SwapRouter02
 * interface fix (creator-buy swaps reverted against the v1 ABI). Deploys:
 *   1. ArchLaunchpadFactory  (pairToken = native USDC, launchFee = 0)
 *   2. ArchFeeDistributor    (references the new factory)
 *   3. GraduationRegistry    (references the new factory)
 * then wires liquidityVault.setFeeDistributor(newDistributor) and verifies.
 * The liquidity vault, splitters, and gas station are unchanged.
 *
 * Writes the new addresses back to deployed-addresses.5042.json.
 * Reads the operator key from .env.mainnet (never printed).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(root, "apps/web/package.json"));
const { createPublicClient, createWalletClient, http, fallback, parseAbi, getAddress, encodeDeployData, formatUnits } = require("viem");
const { privateKeyToAccount } = require("viem/accounts");

const env = Object.fromEntries(
  readFileSync(join(root, ".env.mainnet"), "utf8").split(/\r?\n/)
    .filter((l) => l.includes("=") && !l.trimStart().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]),
);
const addrsPath = join(root, "deployed-addresses.5042.json");
const addrs = JSON.parse(readFileSync(addrsPath, "utf8"));

const account = privateKeyToAccount(env.DEPLOYER_PRIVATE_KEY);
const rpc = env.ARC_MAINNET_RPC_URL ?? "https://rpc.blockdaemon.mainnet.arc.io";
const chain = { id: 5042, name: "arc", nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } };
const transport = fallback([http(rpc, { timeout: 20_000 })]);
const pub = createPublicClient({ chain, transport });
const wallet = createWalletClient({ account, chain, transport });

const USDC = getAddress(env.ARC_MAINNET_USDC_ADDRESS ?? "0x3600000000000000000000000000000000000000");
const LIQUIDITY_VAULT = getAddress(addrs.liquidityVault);
const ARC_SPLITTER = getAddress(addrs.arcSplitter);
const POS_MANAGER = getAddress(env.UNISWAP_V3_POSITION_MANAGER_ADDRESS);
const SWAP_ROUTER = getAddress(env.UNISWAP_V3_SWAP_ROUTER_ADDRESS);
const CREATOR_SHARE_BPS = BigInt(env.PAIR_FEE_CREATOR_SHARE_BPS ?? "1000");
const GRADUATION_UNITS = BigInt(env.GRADUATION_QUOTE_UNITS ?? "9000000000");

function art(name) {
  const j = JSON.parse(readFileSync(join(root, `packages/contracts/out/${name}.sol/${name}.json`), "utf8"));
  return { abi: j.abi, bytecode: j.bytecode.object };
}

async function deploy(name, args) {
  const { abi, bytecode } = art(name);
  const nonce = await pub.getTransactionCount({ address: account.address });
  const hash = await wallet.deployContract({ abi, bytecode, args, nonce, gas: 6_000_000n });
  const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 90_000 });
  if (receipt.status !== "success" || receipt.contractAddress == null) throw new Error(`${name} deploy failed (${hash})`);
  console.log(`${name}: ${receipt.contractAddress}`);
  // Wait until code is visible to avoid estimate races on subsequent calls.
  for (let i = 0; i < 20; i++) {
    const code = await pub.getCode({ address: receipt.contractAddress }).catch(() => undefined);
    if (code !== undefined && code !== "0x") break;
    await new Promise((r) => setTimeout(r, 1500));
  }
  return getAddress(receipt.contractAddress);
}

async function call(label, address, abi, functionName, args) {
  const nonce = await pub.getTransactionCount({ address: account.address });
  const hash = await wallet.writeContract({ address, abi, functionName, args, nonce, gas: 400_000n });
  const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 90_000 });
  console.log(`${label}: ${receipt.status} (${hash})`);
  if (receipt.status !== "success") throw new Error(`${label} reverted`);
}

async function main() {
  const bal = await pub.getBalance({ address: account.address });
  console.log(`operator ${account.address} · gas ${formatUnits(bal, 18)} USDC\n`);

  // 1. Factory — native USDC as the canonical pair token from the constructor,
  //    launch fee 0, fee treasury = the Arc fee splitter.
  const factory = await deploy("ArchLaunchpadFactory", [
    POS_MANAGER, SWAP_ROUTER, LIQUIDITY_VAULT, account.address, USDC, 0n, ARC_SPLITTER,
  ]);

  // 2. Distributor (with the previous factory as legacy so earlier tokens stay
  //    claimable through this one) + 3. Graduation registry.
  const legacyFactory = getAddress(addrs.factory); // current factory becomes legacy
  const distributor = await deploy("ArchFeeDistributor", [
    factory, LIQUIDITY_VAULT, account.address, CREATOR_SHARE_BPS, ARC_SPLITTER, legacyFactory,
  ]);
  const graduation = await deploy("GraduationRegistry", [factory, GRADUATION_UNITS]);

  // 4. Wire the liquidity vault to the new distributor (fee collection path).
  const lvAbi = parseAbi(["function setFeeDistributor(address)", "function feeDistributor() view returns (address)"]);
  await call("liquidityVault.setFeeDistributor", LIQUIDITY_VAULT, lvAbi, "setFeeDistributor", [distributor]);

  // 5. Verify wiring.
  const facAbi = parseAbi(["function pairToken() view returns (address)", "function launchFee() view returns (uint256)", "function allowedPairTokens(address) view returns (bool)"]);
  const [pair, fee, usdcAllowed, wiredDist] = await Promise.all([
    pub.readContract({ address: factory, abi: facAbi, functionName: "pairToken" }),
    pub.readContract({ address: factory, abi: facAbi, functionName: "launchFee" }),
    pub.readContract({ address: factory, abi: facAbi, functionName: "allowedPairTokens", args: [USDC] }),
    pub.readContract({ address: LIQUIDITY_VAULT, abi: lvAbi, functionName: "feeDistributor" }),
  ]);
  console.log(`\nverify: pairToken=${pair} launchFee=${fee} usdcAllowed=${usdcAllowed} vault.feeDistributor=${wiredDist}`);
  if (getAddress(pair) !== USDC || fee !== 0n || !usdcAllowed || getAddress(wiredDist) !== distributor) {
    throw new Error("verification failed");
  }

  addrs.factoryOld = addrs.factory;
  addrs.distributorOld = addrs.distributor;
  addrs.graduationOld = addrs.graduation;
  addrs.factory = factory;
  addrs.distributor = distributor;
  addrs.graduation = graduation;
  writeFileSync(addrsPath, JSON.stringify(addrs, null, 2) + "\n");
  console.log("\naddress book updated. Next: update Vercel env (factory/distributor/graduation) and redeploy web.");
}

main().catch((e) => { console.error("\nFAILED:", e.shortMessage || e.message); process.exit(1); });
