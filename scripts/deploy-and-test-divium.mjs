#!/usr/bin/env node
/**
 * Deploy the v4 launch stack (factory v4 + mode distributor) and prove Divium
 * end to end with real money: launch a DIVIUM token, trade it to generate
 * pool fees, distribute, and verify a holder accrues and can claim USDC.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(root, "apps/web/package.json"));
const { createPublicClient, createWalletClient, http, parseAbi, getAddress, decodeEventLog, formatUnits } = require("viem");
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

const USDC = getAddress(env.ARC_MAINNET_USDC_ADDRESS);
const VAULT = getAddress(addrs.liquidityVault);
const SPLITTER = getAddress(addrs.arcSplitter);
const NPM = getAddress(env.UNISWAP_V3_POSITION_MANAGER_ADDRESS);
const ROUTER = getAddress(env.UNISWAP_V3_SWAP_ROUTER_ADDRESS);
const LEGACY = getAddress(addrs.factory);

const art = (n) => JSON.parse(readFileSync(join(root, `packages/contracts/out/${n}.sol/${n}.json`), "utf8"));
const erc20 = parseAbi(["function approve(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)", "function allowance(address,address) view returns (uint256)"]);

async function send(label, params) {
  const nonce = await pub.getTransactionCount({ address: account.address });
  const hash = await wallet.writeContract({ ...params, nonce });
  const r = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
  console.log(`  ${label}: ${r.status}`);
  if (r.status !== "success") throw new Error(`${label} reverted (${hash})`);
  return r;
}
async function deploy(name, args, gas) {
  const a = art(name);
  const nonce = await pub.getTransactionCount({ address: account.address });
  const hash = await wallet.deployContract({ abi: a.abi, bytecode: a.bytecode.object, args, nonce, gas });
  const r = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
  if (r.status !== "success" || r.contractAddress == null) throw new Error(`${name} deploy failed`);
  console.log(`${name}: ${r.contractAddress}`);
  for (let i = 0; i < 20; i++) {
    const code = await pub.getCode({ address: r.contractAddress }).catch(() => undefined);
    if (code !== undefined && code !== "0x") break;
    await new Promise((s) => setTimeout(s, 1500));
  }
  return getAddress(r.contractAddress);
}

async function main() {
  console.log(`operator gas: ${formatUnits(await pub.getBalance({ address: account.address }), 18)} USDC\n`);

  // ---- deploy v4 stack
  const factory = await deploy("ArchLaunchpadFactoryV4", [NPM, ROUTER, VAULT, account.address, USDC, 0n, SPLITTER], 6_000_000n);
  const distributor = await deploy("ArchModeDistributor",
    [factory, VAULT, account.address, BigInt(env.PAIR_FEE_CREATOR_SHARE_BPS ?? "1000"), SPLITTER, LEGACY, ROUTER], 5_000_000n);

  const facAbi = art("ArchLaunchpadFactoryV4").abi;
  const distAbi = art("ArchModeDistributor").abi;
  const lvAbi = parseAbi(["function setFeeDistributor(address)"]);

  console.log("\nwiring:");
  await send("factory.setModeDistributor", { address: factory, abi: facAbi, functionName: "setModeDistributor", args: [distributor], gas: 200_000n });
  await send("vault.setFeeDistributor", { address: VAULT, abi: lvAbi, functionName: "setFeeDistributor", args: [distributor], gas: 200_000n });

  // ---- launch a DIVIUM token with an initial buy (so we hold supply)
  console.log("\nlaunching DIVIUM token:");
  const BUY = 300_000n; // 0.30 USDC creator buy
  const allowance = await pub.readContract({ address: USDC, abi: erc20, functionName: "allowance", args: [account.address, factory] });
  if (allowance < BUY) await send("approve USDC", { address: USDC, abi: erc20, functionName: "approve", args: [factory, BUY * 10n], gas: 120_000n });

  const deadline = BigInt(Math.floor(Date.now() / 1000) + 900);
  const r = await send("launch", {
    address: factory, abi: facAbi, functionName: "launch", gas: 8_000_000n,
    args: [{
      name: "Divium Test", symbol: "DIVT", metadataUri: "data:application/json;base64,e30=",
      pairToken: USDC, creatorBuyAmount: BUY, minTokensOut: 0n, deadline,
      feeRecipient: "0x0000000000000000000000000000000000000000", taxBps: 0n, mode: 1,
    }],
  });
  let token = null;
  for (const log of r.logs) {
    try { token = decodeEventLog({ abi: facAbi, data: log.data, topics: log.topics }).args.token; if (token) break; } catch { /* skip */ }
  }
  console.log(`  token: ${token}`);

  const tokenAbi = art("ArchLaunchTokenV2").abi;
  const held = await pub.readContract({ address: token, abi: erc20, functionName: "balanceOf", args: [account.address] });
  console.log(`  holder balance: ${formatUnits(held, 18)} DIVT`);
  const eligible = await pub.readContract({ address: token, abi: tokenAbi, functionName: "rewardEligibleSupply" });
  console.log(`  reward-eligible supply: ${formatUnits(eligible, 18)}`);

  // ---- generate fees: a sell back into the pool
  console.log("\ngenerating pool fees (sell half back):");
  const routerAbi = parseAbi(["function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256)"]);
  await send("approve token->router", { address: token, abi: erc20, functionName: "approve", args: [ROUTER, held], gas: 150_000n });
  await send("sell", {
    address: ROUTER, abi: routerAbi, functionName: "exactInputSingle", gas: 500_000n,
    args: [{ tokenIn: token, tokenOut: USDC, fee: 10_000, recipient: account.address, amountIn: held / 2n, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n }],
  });

  // ---- distribute -> Divium should accrue to holders, not pay the creator
  console.log("\ndistributing fees (DIVIUM mode):");
  const usdcBefore = await pub.readContract({ address: USDC, abi: erc20, functionName: "balanceOf", args: [account.address] });
  await send("distribute", { address: distributor, abi: distAbi, functionName: "distribute", args: [token], gas: 2_000_000n });

  const idx = await pub.readContract({ address: token, abi: tokenAbi, functionName: "rewardPerTokenStored" });
  const earned = await pub.readContract({ address: token, abi: tokenAbi, functionName: "earned", args: [account.address] });
  const distUsdc = await pub.readContract({ address: USDC, abi: erc20, functionName: "balanceOf", args: [distributor] });
  console.log(`  rewardPerTokenStored: ${idx}`);
  console.log(`  holder earned: ${formatUnits(earned, 6)} USDC`);
  console.log(`  distributor holds: ${formatUnits(distUsdc, 6)} USDC`);

  if (earned === 0n) throw new Error("DIVIUM FAILED: holder accrued nothing");

  // ---- claim
  console.log("\nclaiming holder rewards:");
  await send("claimRewards", { address: distributor, abi: distAbi, functionName: "claimRewards", args: [token], gas: 400_000n });
  const usdcAfter = await pub.readContract({ address: USDC, abi: erc20, functionName: "balanceOf", args: [account.address] });
  const delta = usdcAfter - usdcBefore;
  console.log(`  holder USDC delta: ${formatUnits(delta, 6)}`);
  if (delta <= 0n) throw new Error("DIVIUM FAILED: claim paid nothing");

  addrs.factoryV4 = factory;
  addrs.modeDistributor = distributor;
  addrs.diviumTestToken = token;
  writeFileSync(addrsPath, JSON.stringify(addrs, null, 2) + "\n");
  console.log("\nPASS: Divium works end to end — holders accrue USDC from trading fees and can claim it.");
  console.log(`HIDE THIS TEST TOKEN: ${token}`);
}

main().catch((e) => { console.error("\nFAILED:", e.shortMessage || e.message); process.exit(1); });
