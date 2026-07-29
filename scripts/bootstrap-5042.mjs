#!/usr/bin/env node
/**
 * Bootstrap native USDC gas onto chain 5042 via Envelope's own bridge + gas
 * station (the only safe public path today). Stages:
 *   deposit  — approve + deposit USDC into Envelope's vault on Base
 *   status   — poll operator's eUSD balance on 5042
 *   gas      — quote + permit + drip native USDC via Envelope's relayer
 * Reads the operator key from .env.mainnet (never printed).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(root, "apps", "web", "package.json"));
const { createPublicClient, createWalletClient, http, encodeFunctionData, formatUnits, parseAbi } = require("viem");
const { privateKeyToAccount } = require("viem/accounts");

const env = Object.fromEntries(
  readFileSync(join(root, ".env.mainnet"), "utf8").split(/\r?\n/)
    .filter((l) => l.includes("=") && !l.trimStart().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]),
);
const account = privateKeyToAccount(env.DEPLOYER_PRIVATE_KEY);
const OP = account.address;

const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const ENV_VAULT = "0x01a29660520C693615A62382603a4cAC7ffD4A15"; // Envelope vault (Base)
const ENV_EUSD = "0x01a29660520C693615A62382603a4cAC7ffD4A15";  // eUSD (5042)

const base = createPublicClient({ transport: http("https://mainnet.base.org") });
const arc = createPublicClient({ transport: http("https://5042.rpc.thirdweb.com") });
const baseWallet = createWalletClient({ account, transport: http("https://mainnet.base.org") });
const baseDef = { id: 8453, name: "base", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: ["https://mainnet.base.org"] } } };

const erc20 = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
]);
const vaultAbi = parseAbi([
  "function deposit(uint256 amount, address recipient)",
  "function feeBps() view returns (uint256)",
  "function minDeposit() view returns (uint256)",
  "function maxDeposit() view returns (uint256)",
  "function depositsPaused() view returns (bool)",
]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function retry(fn, n = 6) {
  for (let i = 0; ; i++) {
    try { return await fn(); }
    catch (e) { if (i >= n || String(e.message ?? e).includes("reverted")) throw e; await sleep(2000 * (i + 1)); }
  }
}
async function baseSend(to, data) {
  const hash = await retry(() => baseWallet.sendTransaction({ chain: baseDef, to, data }));
  const r = await retry(() => base.waitForTransactionReceipt({ hash, timeout: 120000 }));
  if (r.status !== "success") throw new Error(`tx reverted ${hash}`);
  return hash;
}

const cmd = process.argv[2] ?? "status";
const amountUsdc = BigInt(process.argv[3] ?? "25000000"); // default 25 USDC (Envelope min)

if (cmd === "deposit") {
  const [paused, fee, min, max, bal] = await Promise.all([
    base.readContract({ address: ENV_VAULT, abi: vaultAbi, functionName: "depositsPaused" }),
    base.readContract({ address: ENV_VAULT, abi: vaultAbi, functionName: "feeBps" }),
    base.readContract({ address: ENV_VAULT, abi: vaultAbi, functionName: "minDeposit" }),
    base.readContract({ address: ENV_VAULT, abi: vaultAbi, functionName: "maxDeposit" }),
    base.readContract({ address: BASE_USDC, abi: erc20, functionName: "balanceOf", args: [OP] }),
  ]);
  console.log(`Envelope vault: paused=${paused} fee=${fee}bps min=${formatUnits(min,6)} max=${formatUnits(max,6)} USDC`);
  console.log(`Operator USDC: ${formatUnits(bal,6)} | depositing ${formatUnits(amountUsdc,6)}`);
  if (paused) throw new Error("Envelope deposits are paused — cannot bootstrap this way right now");
  if (amountUsdc < min) throw new Error(`amount below Envelope min ${formatUnits(min,6)}`);
  if (bal < amountUsdc) throw new Error("insufficient USDC");

  const allowance = await retry(() => base.readContract({ address: BASE_USDC, abi: erc20, functionName: "allowance", args: [OP, ENV_VAULT] }));
  if (allowance < amountUsdc) {
    console.log("approving USDC to Envelope vault…");
    await baseSend(BASE_USDC, encodeFunctionData({ abi: erc20, functionName: "approve", args: [ENV_VAULT, amountUsdc] }));
  }
  console.log("depositing to Envelope (recipient = operator on 5042)…");
  const h = await baseSend(ENV_VAULT, encodeFunctionData({ abi: vaultAbi, functionName: "deposit", args: [amountUsdc, OP] }));
  const net = amountUsdc - (amountUsdc * fee) / 10000n;
  console.log(`deposit tx: ${h}`);
  console.log(`Envelope will mint ~${formatUnits(net,6)} eUSD to ${OP} on 5042 (async, ~1 min). Run: node scripts/bootstrap-5042.mjs status`);
} else if (cmd === "status") {
  const [eusd, gas] = await Promise.all([
    arc.readContract({ address: ENV_EUSD, abi: erc20, functionName: "balanceOf", args: [OP] }),
    arc.getBalance({ address: OP }),
  ]);
  console.log(`5042 eUSD: ${formatUnits(eusd,6)} | 5042 native gas: ${formatUnits(gas,18)}`);
} else {
  console.log("usage: deposit [amountUnits] | status");
}
