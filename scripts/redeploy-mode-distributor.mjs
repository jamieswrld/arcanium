#!/usr/bin/env node
/**
 * Redeploy the mode distributor (adds adminSetMode for pre-v4 tokens), rewire
 * the factory + liquidity vault to it, and tag existing tokens with a mode.
 *
 *   node scripts/redeploy-mode-distributor.mjs [token=mode ...]
 *   e.g. node scripts/redeploy-mode-distributor.mjs 0x356d…57f5=2
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(root, "apps/web/package.json"));
const { createPublicClient, createWalletClient, http, parseAbi, getAddress, formatUnits } = require("viem");
const { privateKeyToAccount } = require("viem/accounts");

const env = Object.fromEntries(
  readFileSync(join(root, ".env.mainnet"), "utf8").split(/\r?\n/)
    .filter((l) => l.includes("=") && !l.trimStart().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]),
);
const addrsPath = join(root, "deployed-addresses.5042.json");
const addrs = JSON.parse(readFileSync(addrsPath, "utf8"));

const account = privateKeyToAccount(env.DEPLOYER_PRIVATE_KEY);
const rpc = env.ARC_MAINNET_RPC_URL;
const chain = { id: 5042, name: "arc", nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } };
const pub = createPublicClient({ chain, transport: http(rpc, { timeout: 25_000 }) });
const wallet = createWalletClient({ account, chain, transport: http(rpc, { timeout: 25_000 }) });

const art = (n) => JSON.parse(readFileSync(join(root, `packages/contracts/out/${n}.sol/${n}.json`), "utf8"));

async function send(label, params) {
  const nonce = await pub.getTransactionCount({ address: account.address });
  const hash = await wallet.writeContract({ ...params, nonce });
  const r = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
  console.log(`  ${label}: ${r.status}`);
  if (r.status !== "success") throw new Error(`${label} reverted`);
}

async function main() {
  const a = art("ArchModeDistributor");
  const FACTORY = getAddress(addrs.factoryV4);
  const VAULT = getAddress(addrs.liquidityVault);
  const SPLITTER = getAddress(addrs.arcSplitter);
  const LEGACY = getAddress(addrs.factory); // v3 factory, for pre-v4 launches
  const ROUTER = getAddress(env.UNISWAP_V3_SWAP_ROUTER_ADDRESS);

  console.log(`gas: ${formatUnits(await pub.getBalance({ address: account.address }), 18)} USDC\n`);

  const nonce = await pub.getTransactionCount({ address: account.address });
  const hash = await wallet.deployContract({
    abi: a.abi, bytecode: a.bytecode.object, nonce, gas: 5_500_000n,
    args: [FACTORY, VAULT, account.address, BigInt(env.PAIR_FEE_CREATOR_SHARE_BPS ?? "1000"), SPLITTER, LEGACY, ROUTER],
  });
  const r = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
  if (r.status !== "success" || r.contractAddress == null) throw new Error("deploy failed");
  const distributor = getAddress(r.contractAddress);
  console.log(`ArchModeDistributor: ${distributor}`);
  for (let i = 0; i < 20; i++) {
    const code = await pub.getCode({ address: distributor }).catch(() => undefined);
    if (code !== undefined && code !== "0x") break;
    await new Promise((s) => setTimeout(s, 1500));
  }

  console.log("\nwiring:");
  const facAbi = parseAbi(["function setModeDistributor(address)"]);
  const lvAbi = parseAbi(["function setFeeDistributor(address)"]);
  await send("factory.setModeDistributor", { address: FACTORY, abi: facAbi, functionName: "setModeDistributor", args: [distributor], gas: 200_000n });
  await send("vault.setFeeDistributor", { address: VAULT, abi: lvAbi, functionName: "setFeeDistributor", args: [distributor], gas: 200_000n });

  // Point known legacy tokens at the factory that launched them.
  const OVERRIDES = [
    ["0x356d6137bde83A8454964D91da5Df75c3bad57F5", addrs.factoryOld], // The Arcane (v2 factory)
  ];
  console.log("factory overrides:");
  for (const [tok, fac] of OVERRIDES) {
    if (fac === undefined) continue;
    await send(`setFactoryOverride(${tok.slice(0, 10)}…)`, {
      address: distributor, abi: a.abi, functionName: "setFactoryOverride", args: [getAddress(tok), getAddress(fac)], gas: 200_000n,
    });
  }

  // Tag any tokens passed as token=mode
  const tags = process.argv.slice(2).filter((x) => x.includes("="));
  if (tags.length > 0) console.log("\ntagging existing tokens:");
  for (const t of tags) {
    const [tok, m] = t.split("=");
    await send(`adminSetMode(${tok.slice(0, 10)}… -> ${m})`, {
      address: distributor, abi: a.abi, functionName: "adminSetMode", args: [getAddress(tok), Number(m)], gas: 200_000n,
    });
    const set = await pub.readContract({ address: distributor, abi: a.abi, functionName: "modeOf", args: [getAddress(tok)] });
    console.log(`    verified mode = ${set}`);
  }

  addrs.modeDistributorOld = addrs.modeDistributor;
  addrs.modeDistributor = distributor;
  writeFileSync(addrsPath, JSON.stringify(addrs, null, 2) + "\n");
  console.log(`\nDone. Set NEXT_PUBLIC_ARCH_MODE_DISTRIBUTOR_ADDRESS=${distributor}`);
}

main().catch((e) => { console.error("FAILED:", e.shortMessage || e.message); process.exit(1); });
