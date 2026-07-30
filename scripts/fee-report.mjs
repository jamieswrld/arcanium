#!/usr/bin/env node
/**
 * Protocol fee report — everything Arcanium has earned so far, across:
 *   Base  : bridge-era deposit fees (splitter balance + amounts already paid
 *           out to the five fee wallets)
 *   Arc   : launchpad splitter balances, gas-station collected aUSD, and
 *           uncollected LP fees sitting in each launch position (tokensOwed).
 * Read-only; never prints keys.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(root, "apps/web/package.json"));
const { createPublicClient, http, parseAbi, getAddress, formatUnits } = require("viem");

const env = Object.fromEntries(
  readFileSync(join(root, ".env.mainnet"), "utf8").split(/\r?\n/)
    .filter((l) => l.includes("=") && !l.trimStart().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]),
);
const addrs = JSON.parse(readFileSync(join(root, "deployed-addresses.5042.json"), "utf8"));

const base = createPublicClient({ transport: http("https://base-mainnet.infura.io/v3/49e8d9d19fec4a749d7f1e4ca8792977", { timeout: 20000 }) });
const arc = createPublicClient({ transport: http(env.ARC_MAINNET_RPC_URL, { timeout: 20000 }) });

const BASE_USDC = getAddress(env.BASE_MAINNET_USDC_ADDRESS);
const ARC_USDC = getAddress(env.ARC_MAINNET_USDC_ADDRESS);
const AUSD = getAddress(addrs.ausd);
const BASE_SPLITTER = getAddress(addrs.baseSplitter);
const ARC_SPLITTER = getAddress(addrs.arcSplitter);
const GAS_STATION = getAddress(addrs.gasStation);
const POS_MGR = getAddress(env.UNISWAP_V3_POSITION_MANAGER_ADDRESS);
const RECIPIENTS = (env.FEE_RECIPIENTS ?? "").split(",").map((s) => getAddress(s.trim())).filter(Boolean);

const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);
const posAbi = parseAbi([
  "function positions(uint256) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)",
]);
const facAbi = parseAbi([
  "function allTokensLength() view returns (uint256)",
  "function allTokens(uint256) view returns (address)",
  "function launches(address) view returns (address token, address creator, address pairToken, address pool, uint256 positionId)",
]);

const f6 = (v) => formatUnits(v, 6);

async function main() {
  console.log("=== BASE (bridge era) ===");
  const splitterBase = await base.readContract({ address: BASE_USDC, abi: erc20, functionName: "balanceOf", args: [BASE_SPLITTER] });
  console.log(`base splitter undistributed : ${f6(splitterBase)} USDC`);
  let paidOut = 0n;
  for (const r of RECIPIENTS) {
    const bal = await base.readContract({ address: BASE_USDC, abi: erc20, functionName: "balanceOf", args: [r] });
    paidOut += bal;
    console.log(`  wallet ${r.slice(0, 10)}… holds ${f6(bal)} USDC`);
  }
  console.log(`  (sum currently held by fee wallets on Base: ${f6(paidOut)} USDC — includes the distributed bridge fees)`);

  console.log("\n=== ARC (launchpad era) ===");
  const [splitterArcNative, splitterArcAusd, stationAusd] = await Promise.all([
    arc.readContract({ address: ARC_USDC, abi: erc20, functionName: "balanceOf", args: [ARC_SPLITTER] }),
    arc.readContract({ address: AUSD, abi: erc20, functionName: "balanceOf", args: [ARC_SPLITTER] }).catch(() => 0n),
    arc.readContract({ address: AUSD, abi: erc20, functionName: "balanceOf", args: [GAS_STATION] }).catch(() => 0n),
  ]);
  console.log(`arc splitter USDC (trading fees collected): ${f6(splitterArcNative)} USDC`);
  console.log(`arc splitter aUSD (legacy)                : ${f6(splitterArcAusd)} aUSD`);
  console.log(`gas station collected aUSD (drip margins) : ${f6(stationAusd)} aUSD`);

  console.log("\n--- uncollected LP fees per launch (tokensOwed in position) ---");
  let pendingQuote = 0n;
  for (const [label, F] of [["new", getAddress(addrs.factory)], ["old", getAddress(addrs.factoryOld ?? addrs.factory)]]) {
    const n = await arc.readContract({ address: F, abi: facAbi, functionName: "allTokensLength" }).catch(() => 0n);
    for (let i = 0n; i < n; i++) {
      const t = await arc.readContract({ address: F, abi: facAbi, functionName: "allTokens", args: [i] });
      const [, , pairToken, , positionId] = await arc.readContract({ address: F, abi: facAbi, functionName: "launches", args: [t] });
      const p = await arc.readContract({ address: POS_MGR, abi: posAbi, functionName: "positions", args: [positionId] }).catch(() => null);
      if (p === null) continue;
      const tokenIsToken0 = t.toLowerCase() < pairToken.toLowerCase();
      const owedQuote = tokenIsToken0 ? p[11] : p[10];
      pendingQuote += owedQuote;
      console.log(`  [${label}] ${t.slice(0, 10)}… pos#${positionId} quote-side owed: ${f6(owedQuote)} (of which 90% protocol)`);
    }
  }
  console.log(`\npending quote-side LP fees (all pools): ${f6(pendingQuote)} — protocol share ≈ ${f6((pendingQuote * 9n) / 10n)}`);
  console.log("(note: tokensOwed updates when the position is poked; live unaccrued fees can be slightly higher)");
}

main().catch((e) => { console.error("FAILED:", e.shortMessage || e.message); process.exit(1); });
