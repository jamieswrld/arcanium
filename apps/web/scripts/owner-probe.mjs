import { createPublicClient, http, fallback } from "viem";

/**
 * Is the fee owner an EOA, or a contract we might control indirectly
 * (Safe, timelock, another Ownable)? That decides whether the fee change is
 * blocked outright or merely routed through something else.
 */
const c = createPublicClient({
  transport: fallback(
    ["https://rpc.arc-scan.org", "https://rpc.blockdaemon.mainnet.arc.io", "https://5042.rpc.thirdweb.com"].map(
      (u) => http(u, { timeout: 15_000, retryCount: 1 }),
    ),
  ),
});

const OWNER = "0x8fA45d6cA2D97fcfa7496C4D34647EC3CBB48764";
const DEPLOYER = "0x582525844FC8D68C5B7515d2199CDd4f72C6816a";
const USDC = "0x3600000000000000000000000000000000000000";

const f = (n, i, o) => ({ type: "function", name: n, stateMutability: "view", inputs: i, outputs: o });
const probes = [
  { name: "owner", abi: [f("owner", [], [{ type: "address" }])] },
  { name: "getOwners", abi: [f("getOwners", [], [{ type: "address[]" }])] },      // Gnosis Safe
  { name: "getThreshold", abi: [f("getThreshold", [], [{ type: "uint256" }])] },  // Gnosis Safe
  { name: "admin", abi: [f("admin", [], [{ type: "address" }])] },
];

const code = await c.getCode({ address: OWNER }).catch(() => null);
const isContract = code !== null && code !== undefined && code !== "0x";
console.log("owner:", OWNER);
console.log("  contract:", isContract ? `yes (${(code.length - 2) / 2} bytes)` : "NO — plain wallet (EOA)");

if (isContract) {
  for (const p of probes) {
    const v = await c
      .readContract({ address: OWNER, abi: p.abi, functionName: p.name })
      .catch(() => null);
    if (v !== null) console.log(`  ${p.name}():`, v);
  }
} else {
  console.log("  -> only the holder of this wallet's private key can change fee routing.");
}

console.log("\nnonce (has it ever sent a tx?):", await c.getTransactionCount({ address: OWNER }).catch(() => "?"));

const erc = [f("balanceOf", [{ type: "address" }], [{ type: "uint256" }])];
const places = {
  "splitter 0x1E8334F3": "0x1E8334F3009EC6a0fBF77a1Faaa26B1265f560eF",
  "distributor 0x7c148B6a": "0x7c148B6a581E32CcB6ffF7Bd59AF4250d5ec1eBc",
  "distributor 0xed233972": "0xed233972c8a24dFA91671B94E2bb0B1E1E2f943D",
  "fee owner 0x8fA45d6c": OWNER,
  "deployer 0x58252584": DEPLOYER,
  "target 0xdF04c8f6": "0xdF04c8f699062B8d94f980A1d9d563Adf030e647",
};
console.log("\nUSDC sitting in each place:");
for (const [label, addr] of Object.entries(places)) {
  const b = await c.readContract({ address: USDC, abi: erc, functionName: "balanceOf", args: [addr] }).catch(() => null);
  console.log(`  ${label.padEnd(24)} ${b === null ? "unreadable" : (Number(b) / 1e6).toFixed(6) + " USDC"}`);
}
