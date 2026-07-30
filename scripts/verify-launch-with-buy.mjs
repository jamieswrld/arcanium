#!/usr/bin/env node
/**
 * End-to-end proof that a launch WITH an atomic creator buy works on mainnet
 * (this is the path that reverted against the v1 router ABI). Launches a
 * throwaway token with a 0.01 USDC initial buy from the operator and asserts
 * the creator actually received tokens from the swap.
 */
import { readFileSync } from "node:fs";
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
const addrs = JSON.parse(readFileSync(join(root, "deployed-addresses.5042.json"), "utf8"));

const account = privateKeyToAccount(env.DEPLOYER_PRIVATE_KEY);
const rpc = env.ARC_MAINNET_RPC_URL ?? "https://rpc.blockdaemon.mainnet.arc.io";
const chain = { id: 5042, name: "arc", nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } };
const pub = createPublicClient({ chain, transport: http(rpc, { timeout: 20_000 }) });
const wallet = createWalletClient({ account, chain, transport: http(rpc, { timeout: 20_000 }) });

const FACTORY = getAddress(addrs.factory);
const USDC = getAddress(env.ARC_MAINNET_USDC_ADDRESS);
const BUY = 10_000n; // 0.01 USDC (6d)

const erc20 = parseAbi([
  "function approve(address,uint256) returns (bool)",
  "function allowance(address,address) view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
]);
const fac = parseAbi([
  "function launch((string name,string symbol,string metadataUri,address pairToken,uint256 creatorBuyAmount,uint256 minTokensOut,uint256 deadline,address feeRecipient) params) returns (address token, address pool, uint256 positionId)",
  "function launches(address) view returns (address token, address creator, address pairToken, address pool, uint256 positionId)",
]);
// Fee-redirect test target: rewards should land on this wallet, not the
// launcher. Use a known fee wallet from env (any EVM address works).
const REDIRECT = getAddress((env.FEE_RECIPIENTS ?? "").split(",")[2].trim());
const launchedEvent = {
  type: "event", name: "Launched",
  inputs: [
    { name: "token", type: "address", indexed: true },
    { name: "creator", type: "address", indexed: true },
    { name: "pairToken", type: "address", indexed: false },
    { name: "pool", type: "address", indexed: false },
    { name: "positionId", type: "uint256", indexed: false },
    { name: "metadataUri", type: "string", indexed: false },
  ],
};

async function main() {
  console.log(`operator: ${account.address}`);
  console.log(`factory : ${FACTORY}`);
  const gas = await pub.getBalance({ address: account.address });
  console.log(`gas/USDC: ${formatUnits(gas, 18)}`);

  const allowance = await pub.readContract({ address: USDC, abi: erc20, functionName: "allowance", args: [account.address, FACTORY] });
  if (allowance < BUY) {
    let nonce = await pub.getTransactionCount({ address: account.address });
    const a = await wallet.writeContract({ address: USDC, abi: erc20, functionName: "approve", args: [FACTORY, BUY], nonce, gas: 120_000n });
    console.log(`approve: ${(await pub.waitForTransactionReceipt({ hash: a, timeout: 60_000 })).status}`);
  }

  const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
  const nonce = await pub.getTransactionCount({ address: account.address });
  const hash = await wallet.writeContract({
    address: FACTORY, abi: fac, functionName: "launch",
    args: [{ name: "Redirect Check", symbol: "RDCK", metadataUri: "data:application/json;base64,e30=", pairToken: USDC, creatorBuyAmount: BUY, minTokensOut: 0n, deadline, feeRecipient: REDIRECT }],
    nonce, gas: 8_000_000n,
  });
  console.log(`launch tx: ${hash}`);
  const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
  console.log(`status: ${receipt.status} gasUsed=${receipt.gasUsed}`);
  if (receipt.status !== "success") throw new Error("LAUNCH WITH BUY STILL REVERTS");

  let token = null;
  for (const log of receipt.logs) {
    try { token = decodeEventLog({ abi: [launchedEvent], data: log.data, topics: log.topics }).args.token; break; } catch { /* not it */ }
  }
  if (token === null) throw new Error("Launched event not found");
  console.log(`token: ${token}`);
  const got = await pub.readContract({ address: token, abi: erc20, functionName: "balanceOf", args: [account.address] });
  console.log(`launcher token balance from atomic buy: ${formatUnits(got, 18)}`);
  if (got === 0n) throw new Error("launcher received no tokens — swap did not execute");

  // Fee redirect assertion: rewards owner must be the REDIRECT wallet.
  const [, rewardsOwner] = await pub.readContract({ address: FACTORY, abi: fac, functionName: "launches", args: [token] });
  console.log(`rewards owner: ${rewardsOwner} (expected ${REDIRECT})`);
  if (getAddress(rewardsOwner) !== REDIRECT) throw new Error("fee redirect NOT stored");

  console.log("\nPASS: launch + atomic buy + fee redirect all work. Hide this token in the UI:");
  console.log(`HIDDEN: ${token}`);
}

main().catch((e) => { console.error("\nFAILED:", e.shortMessage || e.message); process.exit(1); });
