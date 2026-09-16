import { createPublicClient, http, fallback } from "viem";

const ARC = fallback(
  ["https://rpc.arc-scan.org", "https://rpc.blockdaemon.mainnet.arc.io", "https://5042.rpc.thirdweb.com"].map(
    (u) => http(u, { timeout: 15_000, retryCount: 1 }),
  ),
);
const c = createPublicClient({ transport: ARC });

const f = (n, i, o) => ({ type: "function", name: n, stateMutability: "view", inputs: i, outputs: o });
const splitAbi = [
  f("recipientCount", [], [{ type: "uint256" }]),
  f("recipients", [{ type: "uint256" }], [{ type: "address" }]),
  f("weightsBps", [{ type: "uint256" }], [{ type: "uint256" }]),
  f("owner", [], [{ type: "address" }]),
];
const distAbi = [f("protocolTreasury", [], [{ type: "address" }]), f("owner", [], [{ type: "address" }])];
const tokenAbi = [f("taxRecipient", [], [{ type: "address" }])];
const facAbi = [
  f("allTokensLength", [], [{ type: "uint256" }]),
  f("allTokens", [{ type: "uint256" }], [{ type: "address" }]),
];

const TREASURY = "0x1E8334F3009EC6a0fBF77a1Faaa26B1265f560eF";
const OWNER = "0x8fA45d6cA2D97fcfa7496C4D34647EC3CBB48764";
const DEPLOYER = "0x582525844FC8D68C5B7515d2199CDd4f72C6816a";
const FACTORIES = [
  "0x8e5732B520a318251a702a680AA7F123fb92AF52",
  "0xE2aA88806872C2a02A4ab439584d457002983600",
  "0xA024664AD5d30F3c0b18b931DdB6f64A96DE8ED3",
  "0x1d65ab4cDCDdA6f38A9c93a24EF64bE8905e19d5",
];

(async () => {
  console.log("=== what is protocolTreasury 0x1E8334F3…? ===");
  const code = await c.getCode({ address: TREASURY }).catch(() => null);
  console.log("   contract:", code && code !== "0x" ? `yes (${(code.length - 2) / 2} bytes)` : "no — plain wallet (EOA)");
  if (code && code !== "0x") {
    const n = await c.readContract({ address: TREASURY, abi: splitAbi, functionName: "recipientCount" }).catch(() => null);
    if (n !== null) {
      console.log("   looks like a splitter with", Number(n), "recipients:");
      for (let i = 0; i < Number(n); i++) {
        const [r, w] = await Promise.all([
          c.readContract({ address: TREASURY, abi: splitAbi, functionName: "recipients", args: [BigInt(i)] }),
          c.readContract({ address: TREASURY, abi: splitAbi, functionName: "weightsBps", args: [BigInt(i)] }),
        ]);
        console.log(`     ${i}. ${r}  ${Number(w) / 100}%`);
      }
      const o = await c.readContract({ address: TREASURY, abi: splitAbi, functionName: "owner" }).catch(() => "?");
      console.log("   splitter owner:", o, o.toLowerCase() === DEPLOYER.toLowerCase() ? "(= our deployer)" : "(NOT our deployer)");
    } else {
      console.log("   not a splitter — no recipientCount()");
    }
  }

  console.log("\n=== distributor owner ===");
  console.log("  ", OWNER, OWNER.toLowerCase() === DEPLOYER.toLowerCase() ? "(= our deployer)" : "(NOT our deployer — we may not control it)");

  console.log("\n=== which distributors do live tokens actually pay into? ===");
  const seen = new Map();
  for (const factory of FACTORIES) {
    const n = await c.readContract({ address: factory, abi: facAbi, functionName: "allTokensLength" }).catch(() => 0n);
    for (let i = 0; i < Number(n); i++) {
      const t = await c.readContract({ address: factory, abi: facAbi, functionName: "allTokens", args: [BigInt(i)] }).catch(() => null);
      if (!t) continue;
      const rec = await c.readContract({ address: t, abi: tokenAbi, functionName: "taxRecipient" }).catch(() => null);
      if (rec) seen.set(rec, (seen.get(rec) ?? 0) + 1);
    }
  }
  for (const [addr, count] of [...seen.entries()].sort((a, b) => b[1] - a[1])) {
    const [treasury, owner] = await Promise.all([
      c.readContract({ address: addr, abi: distAbi, functionName: "protocolTreasury" }).catch(() => "n/a"),
      c.readContract({ address: addr, abi: distAbi, functionName: "owner" }).catch(() => "n/a"),
    ]);
    console.log(`   ${addr}  used by ${count} token(s)`);
    console.log(`      protocolTreasury: ${treasury}`);
    console.log(`      owner:            ${owner} ${String(owner).toLowerCase() === DEPLOYER.toLowerCase() ? "(ours)" : "(NOT ours)"}`);
  }
})();
