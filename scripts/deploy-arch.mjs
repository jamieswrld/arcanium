#!/usr/bin/env node
/**
 * Arch full-stack deployer. Reads an env file, deploys every contract to the
 * configured Base + Arc chains in order, wires treasuries and roles, sets the
 * fee-splitter recipients, and writes the resulting address book. You run this
 * locally with your own key — it never leaves your machine.
 *
 *   node scripts/deploy-arch.mjs .env.mainnet
 *
 * Proven against testnet (.env) before mainnet use. Requires the contracts to
 * be compiled (packages/contracts/out) and the deployer funded on BOTH chains.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(root, "apps", "web", "package.json"));
const { createPublicClient, createWalletClient, http, encodeAbiParameters, encodeFunctionData, keccak256, toBytes } = require("viem");
const { privateKeyToAccount } = require("viem/accounts");
const BRIDGE_ROLE = keccak256(toBytes("BRIDGE_ROLE"));

// ---- config ---------------------------------------------------------------
const envPath = process.argv[2] ?? ".env";
const env = Object.fromEntries(
  readFileSync(join(root, envPath), "utf8")
    .split(/\r?\n/)
    .filter((l) => l.includes("=") && !l.trimStart().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]),
);
const req = (k) => { if (!env[k]) throw new Error(`missing ${k} in ${envPath}`); return env[k]; };

const IS_MAINNET = env.ENABLE_ARC_MAINNET === "true";
const BASE = {
  rpc: IS_MAINNET ? req("BASE_MAINNET_RPC_URL") : (env.BASE_SEPOLIA_RPC_URL ?? "https://sepolia.base.org"),
  id: Number(IS_MAINNET ? env.BASE_MAINNET_CHAIN_ID ?? 8453 : 84532),
  usdc: IS_MAINNET ? req("BASE_MAINNET_USDC_ADDRESS") : req("VAULT_USDC_ADDRESS"),
};
const ARC = {
  rpc: IS_MAINNET ? req("ARC_MAINNET_RPC_URL") : (env.ARC_RPC_SERVER_URL ?? "https://5042002.rpc.thirdweb.com"),
  id: Number(IS_MAINNET ? req("ARC_MAINNET_CHAIN_ID") : 5042002),
  usdc: IS_MAINNET ? req("ARC_MAINNET_USDC_ADDRESS") : (env.ARC_TESTNET_USDC_ADDRESS ?? "0x3600000000000000000000000000000000000000"),
};

const account = privateKeyToAccount(req("DEPLOYER_PRIVATE_KEY"));
const feeRecipients = req("FEE_RECIPIENTS").split(",").map((s) => s.trim());
const feeWeights = (env.FEE_WEIGHTS ?? "4000,1500,1500,1500,1500").split(",").map((s) => BigInt(s.trim()));

function art(name, sol) {
  return JSON.parse(readFileSync(join(root, "packages/contracts/out", `${sol}.sol`, `${name}.json`), "utf8"));
}
const clients = {};
async function chain(c) {
  if (clients[c.id]) return clients[c.id];
  const chainDef = { id: c.id, name: `chain-${c.id}`, nativeCurrency: { name: "x", symbol: "x", decimals: 18 }, rpcUrls: { default: { http: [c.rpc] } } };
  const pub = createPublicClient({ transport: http(c.rpc) });
  clients[c.id] = {
    pub,
    wallet: createWalletClient({ account, transport: http(c.rpc) }),
    def: chainDef,
    // Explicit nonce tracking eliminates races on flaky public RPCs.
    nonce: await pub.getTransactionCount({ address: account.address, blockTag: "pending" }),
  };
  return clients[c.id];
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Wrap any RPC read with exponential backoff on 429/timeout/transient errors. */
async function backoff(fn, label) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const msg = String(e.message ?? e);
      if (attempt >= 7 || msg.includes("reverted")) throw e;
      const wait = Math.min(1500 * 2 ** attempt, 20000);
      await sleep(wait);
    }
  }
}

async function send(c, tx) {
  const ctx = await chain(c);
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const nonce = ctx.nonce;
      const hash = await backoff(() => ctx.wallet.sendTransaction({ ...tx, chain: ctx.def, nonce }));
      const receipt = await backoff(() => ctx.pub.waitForTransactionReceipt({ hash, timeout: 180000 }));
      if (receipt.status !== "success") throw new Error(`reverted (${hash})`);
      ctx.nonce = nonce + 1;
      await sleep(c.pace ?? 700); // gentle pacing for strict public RPCs
      return receipt;
    } catch (e) {
      const msg = String(e.message ?? e);
      if (msg.includes("reverted")) throw e; // real revert, don't retry
      ctx.nonce = await backoff(() => ctx.pub.getTransactionCount({ address: account.address, blockTag: "pending" }));
      if (attempt === 5) throw e;
      await sleep(3000);
    }
  }
}

async function deploy(c, label, artifact, argTypes, args) {
  let data = artifact.bytecode.object;
  if (argTypes.length) data += encodeAbiParameters(argTypes, args).slice(2);
  const receipt = await send(c, { data });
  const addr = receipt.contractAddress;
  // Wait until the code is visible on the RPC before any call touches it —
  // public RPCs are eventually consistent across backends, and a premature
  // gas estimate against not-yet-visible code produces a fatally low gas cap.
  const ctx = await chain(c);
  for (let i = 0; i < 30; i++) {
    const code = await backoff(() => ctx.pub.getCode({ address: addr })).catch(() => undefined);
    if (code && code.length > 2) break;
    await sleep(2000);
  }
  console.log(`  ✓ ${label}: ${addr}`);
  return addr;
}

async function call(c, label, address, abi, functionName, args, value) {
  const data = encodeFunctionData({ abi, functionName, args });
  // Explicit, generous gas cap so we never depend on a racy estimate. All
  // admin calls here are cheap (< 150k); 400k is ample headroom.
  const tx = { to: address, data, gas: 400000n };
  if (value) tx.value = value;
  await send(c, tx);
  console.log(`  ✓ ${label}`);
}

const A = (t) => ({ type: t });

async function main() {
  console.log(`\nArch deploy — ${IS_MAINNET ? "MAINNET" : "testnet"} | deployer ${account.address}`);
  console.log(`Base chain ${BASE.id} (${BASE.rpc})`);
  console.log(`Arc  chain ${ARC.id} (${ARC.rpc})\n`);

  const owner = env.VAULT_OWNER_ADDRESS || account.address;
  const admin = env.ARC_ADMIN_ADDRESS || account.address;
  const keeper = env.VAULT_KEEPER_ADDRESS || account.address;
  const arcKeeper = env.ARC_KEEPER_ADDRESS || account.address;
  const relayer = env.GAS_RELAYER_ADDRESS || account.address;

  const splitterArt = art("ArchFeeSplitter", "ArchFeeSplitter");
  // Resume support: reuse anything already deployed (saves gas on retries).
  const bookPath = join(root, `deployed-addresses.${ARC.id}.json`);
  let out = {};
  try { out = JSON.parse(readFileSync(bookPath, "utf8")); console.log("resuming from existing address book\n"); } catch { /* fresh */ }
  const have = (k) => typeof out[k] === "string" && out[k].length === 42;

  // ---- Base side ----
  console.log("== Base");
  if (!have("baseSplitter")) out.baseSplitter = await deploy(BASE, "ArchFeeSplitter (Base)", splitterArt,
    [A("address"), A("address[]"), A("uint256[]")], [account.address, feeRecipients, feeWeights]);
  if (!have("vault")) out.vault = await deploy(BASE, "ArchVaultBase", art("ArchVaultBase", "ArchVaultBase"),
    [A("address"), A("address"), A("address"), A("uint256"), A("uint256"), A("uint256"), A("uint256"), A("uint256"), A("uint256")],
    [BASE.usdc, account.address, out.baseSplitter, BigInt(req("BRIDGE_DEPOSIT_FEE_BPS")),
     BigInt(req("BRIDGE_MIN_DEPOSIT_UNITS")), BigInt(req("BRIDGE_MAX_DEPOSIT_UNITS")),
     BigInt(req("BRIDGE_MAX_RELEASE_PER_TX_UNITS")), BigInt(req("BRIDGE_MAX_RELEASE_PER_WINDOW_UNITS")),
     BigInt(req("BRIDGE_RELEASE_WINDOW_SECONDS"))]);
  const vaultAbi = art("ArchVaultBase", "ArchVaultBase").abi;
  if (!have("vault")) await call(BASE, "vault.setKeeper", out.vault, vaultAbi, "setKeeper", [keeper, true]);

  // ---- Arc/5042 side ----
  console.log("== Arc");
  if (!have("arcSplitter")) out.arcSplitter = await deploy(ARC, "ArchFeeSplitter (Arc)", splitterArt,
    [A("address"), A("address[]"), A("uint256[]")], [account.address, feeRecipients, feeWeights]);
  if (!have("ausd")) out.ausd = await deploy(ARC, "ArchUSD", art("ArchUSD", "ArchUSD"), [A("address")], [account.address]);
  const ausdAbi = art("ArchUSD", "ArchUSD").abi;

  if (!have("bridge")) out.bridge = await deploy(ARC, "ArchBridgeArc", art("ArchBridgeArc", "ArchBridgeArc"),
    [A("address"), A("address"), A("uint256"), A("uint256"), A("uint256"), A("uint256")],
    [out.ausd, account.address, BigInt(req("BRIDGE_MIN_REDEEM_UNITS")),
     BigInt(req("BRIDGE_MAX_MINT_PER_TX_UNITS")), BigInt(req("BRIDGE_MAX_MINT_PER_WINDOW_UNITS")), BigInt(req("BRIDGE_MINT_WINDOW_SECONDS"))]);
  const bridgeAbi = art("ArchBridgeArc", "ArchBridgeArc").abi;
  if (!have("bridge")) await call(ARC, "ausd.grantRole(BRIDGE_ROLE, bridge)", out.ausd, ausdAbi, "grantRole", [BRIDGE_ROLE, out.bridge]);
  if (!have("bridge")) await call(ARC, "bridge.setKeeper", out.bridge, bridgeAbi, "setKeeper", [arcKeeper, true]);

  if (!have("gasStation")) out.gasStation = await deploy(ARC, "ArchGasStation", art("ArchGasStation", "ArchGasStation"),
    [A("address"), A("address"), A("uint256"), A("uint256")],
    [out.ausd, account.address, BigInt(env.GAS_STATION_MARGIN_BPS ?? "500"), BigInt(env.GAS_STATION_COOLDOWN_SECONDS ?? "30")]);
  const gsAbi = art("ArchGasStation", "ArchGasStation").abi;
  if (!have("gasStation")) await call(ARC, "gasStation.setRelayer", out.gasStation, gsAbi, "setRelayer", [relayer, true]);
  if (!have("gasStation")) await call(ARC, "gasStation.configureAction(swap)", out.gasStation, gsAbi, "configureAction", [0, 400000n, 1000000000000000000n]);
  if (!have("gasStation")) await call(ARC, "gasStation.configureAction(launch)", out.gasStation, gsAbi, "configureAction", [1, 6000000n, 10000000000000000000n]);
  if (!have("gasStation")) await call(ARC, "gasStation.configureAction(redeem)", out.gasStation, gsAbi, "configureAction", [2, 300000n, 1000000000000000000n]);
  if (!have("gasStation")) await call(ARC, "gasStation.configureAction(approve)", out.gasStation, gsAbi, "configureAction", [3, 120000n, 500000000000000000n]);

  if (!have("liquidityVault")) out.liquidityVault = await deploy(ARC, "ArchLiquidityVault", art("ArchLiquidityVault", "ArchLiquidityVault"),
    [A("address"), A("address")], [req("UNISWAP_V3_POSITION_MANAGER_ADDRESS"), account.address]);
  if (!have("factory")) out.factory = await deploy(ARC, "ArchLaunchpadFactory", art("ArchLaunchpadFactory", "ArchLaunchpadFactory"),
    [A("address"), A("address"), A("address"), A("address"), A("address"), A("uint256"), A("address")],
    [req("UNISWAP_V3_POSITION_MANAGER_ADDRESS"), req("UNISWAP_V3_SWAP_ROUTER_ADDRESS"), out.liquidityVault,
     account.address, out.ausd, BigInt(req("LAUNCH_FEE_QUOTE_UNITS")), out.arcSplitter]);
  if (!have("distributor")) out.distributor = await deploy(ARC, "ArchFeeDistributor", art("ArchFeeDistributor", "ArchFeeDistributor"),
    [A("address"), A("address"), A("address"), A("uint256"), A("address")],
    [out.factory, out.liquidityVault, account.address, BigInt(req("PAIR_FEE_CREATOR_SHARE_BPS")), out.arcSplitter]);
  if (!have("graduation")) out.graduation = await deploy(ARC, "GraduationRegistry", art("GraduationRegistry", "GraduationRegistry"),
    [A("address"), A("uint256")], [out.factory, BigInt(req("GRADUATION_QUOTE_UNITS"))]);
  const lvAbi = art("ArchLiquidityVault", "ArchLiquidityVault").abi;
  await call(ARC, "liquidityVault.setFeeDistributor", out.liquidityVault, lvAbi, "setFeeDistributor", [out.distributor]);

  writeFileSync(join(root, `deployed-addresses.${ARC.id}.json`), JSON.stringify(out, null, 2));
  console.log("\n== DONE. Address book:");
  for (const [k, v] of Object.entries(out)) console.log(`  ${k} = ${v}`);
  console.log("\n== Vercel NEXT_PUBLIC_ env (paste into project settings):");
  console.log(`NEXT_PUBLIC_ARCH_VAULT_BASE_ADDRESS=${out.vault}`);
  console.log(`NEXT_PUBLIC_ARCH_USD_ADDRESS=${out.ausd}`);
  console.log(`NEXT_PUBLIC_ARCH_BRIDGE_ARC_ADDRESS=${out.bridge}`);
  console.log(`NEXT_PUBLIC_ARCH_GAS_STATION_ADDRESS=${out.gasStation}`);
  console.log(`NEXT_PUBLIC_ARCH_LAUNCHPAD_FACTORY_ADDRESS=${out.factory}`);
  console.log(`NEXT_PUBLIC_ARCH_GRADUATION_REGISTRY_ADDRESS=${out.graduation}`);
  console.log(`NEXT_PUBLIC_ARCH_FEE_DISTRIBUTOR_ADDRESS=${out.distributor}`);
  console.log(`NEXT_PUBLIC_UNISWAP_SWAP_ROUTER_ADDRESS=${req("UNISWAP_V3_SWAP_ROUTER_ADDRESS")}`);
  console.log("\nNext: fund the gas station inventory, then run the canary (docs/ops/mainnet-launch-runbook.md).");
}

main().catch((e) => { console.error("\nDEPLOY FAILED:", e.message); process.exit(1); });
