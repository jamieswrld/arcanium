import { createPublicClient, http, fallback } from "viem";

const c = createPublicClient({
  transport: fallback(
    ["https://rpc.arc-scan.org", "https://rpc.blockdaemon.mainnet.arc.io", "https://5042.rpc.thirdweb.com"].map(
      (u) => http(u, { timeout: 15_000, retryCount: 1 }),
    ),
  ),
});

const DEPLOYER = "0x582525844FC8D68C5B7515d2199CDd4f72C6816a";
const f = (n, i, o) => ({ type: "function", name: n, stateMutability: "view", inputs: i, outputs: o });
const abi = [
  f("owner", [], [{ type: "address" }]),
  f("modeDistributor", [], [{ type: "address" }]),
  f("liquidityVault", [], [{ type: "address" }]),
  f("positionManager", [], [{ type: "address" }]),
  f("swapRouter", [], [{ type: "address" }]),
  f("pairToken", [], [{ type: "address" }]),
  f("launchFee", [], [{ type: "uint256" }]),
];

const FACTORIES = {
  "v4 (current)": "0x8e5732B520a318251a702a680AA7F123fb92AF52",
  v3: "0xE2aA88806872C2a02A4ab439584d457002983600",
  v2: "0xA024664AD5d30F3c0b18b931DdB6f64A96DE8ED3",
  v1: "0x1d65ab4cDCDdA6f38A9c93a24EF64bE8905e19d5",
};

for (const [label, address] of Object.entries(FACTORIES)) {
  console.log(`\n--- ${label}  ${address}`);
  for (const fn of ["owner", "modeDistributor", "liquidityVault", "positionManager", "swapRouter", "pairToken", "launchFee"]) {
    const v = await c.readContract({ address, abi, functionName: fn }).catch(() => null);
    if (v === null) continue;
    const mine = fn === "owner" && String(v).toLowerCase() === DEPLOYER.toLowerCase();
    console.log(`    ${fn.padEnd(17)} ${typeof v === "bigint" ? v.toString() : v}${mine ? "   <= OURS" : ""}`);
  }
}

console.log("\ndeployer gas on Arc:", Number(await c.getBalance({ address: DEPLOYER })) / 1e18, "USDC");
