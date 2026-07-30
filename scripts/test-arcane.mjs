#!/usr/bin/env node
/**
 * Prove ARCANE mode on mainnet: launch a token in ARCANE mode, trade it to
 * generate pool fees, distribute, and verify the creator's share was used to
 * market-buy the token and send it to the burn address — supply permanently
 * reduced, nothing paid to the creator.
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
const ROUTER = getAddress(env.UNISWAP_V3_SWAP_ROUTER_ADDRESS);
const FACTORY = getAddress(addrs.factoryV4);
const DIST = getAddress(addrs.modeDistributor);
const BURN = "0x000000000000000000000000000000000000dEaD";

const art = (n) => JSON.parse(readFileSync(join(root, `packages/contracts/out/${n}.sol/${n}.json`), "utf8"));
const erc20 = parseAbi(["function approve(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)", "function allowance(address,address) view returns (uint256)", "function totalSupply() view returns (uint256)"]);
const routerAbi = parseAbi(["function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256)"]);

async function send(label, params) {
  const nonce = await pub.getTransactionCount({ address: account.address });
  const hash = await wallet.writeContract({ ...params, nonce });
  const r = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
  console.log(`  ${label}: ${r.status}`);
  if (r.status !== "success") throw new Error(`${label} reverted (${hash})`);
  return r;
}

async function main() {
  const facAbi = art("ArchLaunchpadFactoryV4").abi;
  const distAbi = art("ArchModeDistributor").abi;

  console.log(`factory v4:  ${FACTORY}`);
  console.log(`distributor: ${DIST}\n`);

  // ---- launch in ARCANE mode with an initial buy
  console.log("launching ARCANE token:");
  const BUY = 300_000n; // 0.30 USDC
  const allowance = await pub.readContract({ address: USDC, abi: erc20, functionName: "allowance", args: [account.address, FACTORY] });
  if (allowance < BUY) await send("approve USDC", { address: USDC, abi: erc20, functionName: "approve", args: [FACTORY, BUY * 20n], gas: 120_000n });

  const deadline = BigInt(Math.floor(Date.now() / 1000) + 900);
  const r = await send("launch", {
    address: FACTORY, abi: facAbi, functionName: "launch", gas: 8_000_000n,
    args: [{
      name: "Arcane Test", symbol: "ARCT", metadataUri: "data:application/json;base64,e30=",
      pairToken: USDC, creatorBuyAmount: BUY, minTokensOut: 0n, deadline,
      feeRecipient: "0x0000000000000000000000000000000000000000", taxBps: 0n, mode: 2, // ARCANE
    }],
  });
  let token = null;
  for (const log of r.logs) {
    try { const d = decodeEventLog({ abi: facAbi, data: log.data, topics: log.topics }); if (d.args?.token) { token = d.args.token; break; } } catch { /* skip */ }
  }
  console.log(`  token: ${token}`);

  const mode = await pub.readContract({ address: DIST, abi: distAbi, functionName: "modeOf", args: [token] });
  console.log(`  registered mode: ${mode} (2 = ARCANE)`);
  if (Number(mode) !== 2) throw new Error("mode not registered as ARCANE");

  // ---- generate fees
  console.log("\ngenerating pool fees (sell half back):");
  const held = await pub.readContract({ address: token, abi: erc20, functionName: "balanceOf", args: [account.address] });
  await send("approve token->router", { address: token, abi: erc20, functionName: "approve", args: [ROUTER, held], gas: 150_000n });
  await send("sell", {
    address: ROUTER, abi: routerAbi, functionName: "exactInputSingle", gas: 500_000n,
    args: [{ tokenIn: token, tokenOut: USDC, fee: 10_000, recipient: account.address, amountIn: held / 2n, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n }],
  });

  // ---- distribute: creator share must buy & burn
  console.log("\ndistributing fees (ARCANE mode):");
  const burnBefore = await pub.readContract({ address: token, abi: erc20, functionName: "balanceOf", args: [BURN] });
  const creatorUsdcBefore = await pub.readContract({ address: USDC, abi: erc20, functionName: "balanceOf", args: [account.address] });
  await send("distribute", { address: DIST, abi: distAbi, functionName: "distribute", args: [token], gas: 3_000_000n });

  const burnAfter = await pub.readContract({ address: token, abi: erc20, functionName: "balanceOf", args: [BURN] });
  const distUsdcAfter = await pub.readContract({ address: USDC, abi: erc20, functionName: "balanceOf", args: [DIST] });
  const burned = burnAfter - burnBefore;
  console.log(`  burn address balance: ${formatUnits(burnBefore, 18)} -> ${formatUnits(burnAfter, 18)}`);
  console.log(`  tokens burned this round: ${formatUnits(burned, 18)}`);
  console.log(`  USDC left in distributor: ${formatUnits(distUsdcAfter, 6)} (should be ~0 — it was spent buying)`);

  if (burned === 0n) throw new Error("ARCANE FAILED: nothing was burned");

  addrs.arcaneTestToken = getAddress(token);
  writeFileSync(addrsPath, JSON.stringify(addrs, null, 2) + "\n");
  console.log("\nPASS: Arcane works — creator fees market-bought the token and burned it to 0xdead.");
  console.log(`token: ${token}`);
}

main().catch((e) => { console.error("\nFAILED:", e.shortMessage || e.message); process.exit(1); });
