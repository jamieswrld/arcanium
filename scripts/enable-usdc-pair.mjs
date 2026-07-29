#!/usr/bin/env node
/**
 * Enable native Arc USDC as a launch pair token (the DYOR/Envelope model:
 * tokens pair with the chain's native money instead of a bridged dollar).
 *
 *   node scripts/enable-usdc-pair.mjs            # allow USDC as a pair token
 *   node scripts/enable-usdc-pair.mjs --canonical # also make it the default
 *
 * Our factory was deployed anticipating this ("aUSD now; native-USDC ERC-20
 * later") — it already has allowedPairTokens + setPairTokenAllowed. This just
 * flips USDC on. Requires the factory owner key (deployer) and a little Arc
 * gas. Safe and reversible (setPairTokenAllowed(usdc,false) undoes it).
 *
 * The factory's price math assumes a 6-decimal quote token, so this asserts
 * the USDC ERC-20 view is 6 decimals before enabling — a mispriced pool would
 * otherwise be baked into every launch.
 *
 * Reads the operator key from .env.mainnet (never printed).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(root, "apps/web/package.json"));
const { createPublicClient, createWalletClient, http, fallback, parseAbi, getAddress } = require("viem");
const { privateKeyToAccount } = require("viem/accounts");

const env = Object.fromEntries(
  readFileSync(join(root, ".env.mainnet"), "utf8").split(/\r?\n/)
    .filter((l) => l.includes("=") && !l.trimStart().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]),
);

const addresses = JSON.parse(readFileSync(join(root, "deployed-addresses.5042.json"), "utf8"));
const FACTORY = getAddress(addresses.factory);
const USDC = getAddress(env.ARC_MAINNET_USDC_ADDRESS ?? "0x3600000000000000000000000000000000000000");
const makeCanonical = process.argv.includes("--canonical");

const account = privateKeyToAccount(env.DEPLOYER_PRIVATE_KEY);
const rpc = env.ARC_MAINNET_RPC_URL ?? "https://5042.rpc.thirdweb.com";
const chain = { id: Number(env.ARC_MAINNET_CHAIN_ID ?? "5042"), name: "arc", nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } };
const transport = fallback([http(rpc), http("https://5042.rpc.thirdweb.com")]);
const pub = createPublicClient({ chain, transport });
const wallet = createWalletClient({ account, chain, transport });

const erc20 = parseAbi(["function decimals() view returns (uint8)", "function symbol() view returns (string)"]);
const fac = parseAbi([
  "function owner() view returns (address)",
  "function allowedPairTokens(address) view returns (bool)",
  "function pairToken() view returns (address)",
  "function setPairTokenAllowed(address token, bool allowed)",
  "function setPairToken(address newPairToken)",
]);

async function main() {
  console.log(`factory : ${FACTORY}`);
  console.log(`usdc    : ${USDC}`);
  console.log(`operator: ${account.address}`);

  const owner = await pub.readContract({ address: FACTORY, abi: fac, functionName: "owner" });
  if (getAddress(owner) !== getAddress(account.address)) {
    throw new Error(`operator is not the factory owner (owner=${owner})`);
  }

  // Guard: the factory's launch price math is written for a 6-decimal quote.
  const dec = await pub.readContract({ address: USDC, abi: erc20, functionName: "decimals" });
  const sym = await pub.readContract({ address: USDC, abi: erc20, functionName: "symbol" }).catch(() => "USDC");
  console.log(`usdc ERC-20 view: ${sym}, ${dec} decimals`);
  if (Number(dec) !== 6) {
    throw new Error(`USDC ERC-20 view is ${dec} decimals, but the factory prices a 6-decimal quote. Aborting — enabling this would misprice every launch.`);
  }

  if (await pub.readContract({ address: FACTORY, abi: fac, functionName: "allowedPairTokens", args: [USDC] })) {
    console.log("USDC already allowed as a pair token.");
  } else {
    const h = await wallet.writeContract({ address: FACTORY, abi: fac, functionName: "setPairTokenAllowed", args: [USDC, true] });
    console.log(`setPairTokenAllowed tx: ${h}`);
    console.log(`  status: ${(await pub.waitForTransactionReceipt({ hash: h })).status}`);
  }

  if (makeCanonical) {
    const h = await wallet.writeContract({ address: FACTORY, abi: fac, functionName: "setPairToken", args: [USDC] });
    console.log(`setPairToken (canonical) tx: ${h}`);
    console.log(`  status: ${(await pub.waitForTransactionReceipt({ hash: h })).status}`);
  }

  console.log(`\nDone. Canonical pairToken is now: ${await pub.readContract({ address: FACTORY, abi: fac, functionName: "pairToken" })}`);
  console.log("Next: set NEXT_PUBLIC_ARCH_PAIR_TOKEN_ADDRESS to the USDC address in Vercel and redeploy the web app.");
}

main().catch((e) => { console.error("\nFAILED:", e.shortMessage || e.message); process.exit(1); });
