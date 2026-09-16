import { createPublicClient, http, fallback } from "viem";

/** Where does every stream of Arcanium fees actually land today? */

const ARC = fallback(
  [
    "https://rpc.arc-scan.org",
    "https://rpc.blockdaemon.mainnet.arc.io",
    "https://5042.rpc.thirdweb.com",
  ].map((u) => http(u, { timeout: 15_000, retryCount: 1 })),
);
const BASE = fallback(
  ["https://mainnet.base.org", "https://base.publicnode.com"].map((u) =>
    http(u, { timeout: 15_000, retryCount: 1 }),
  ),
);

const f = (n, i, o) => ({ type: "function", name: n, stateMutability: "view", inputs: i, outputs: o });
const distAbi = [
  f("protocolTreasury", [], [{ type: "address" }]),
  f("creatorShareBps", [], [{ type: "uint256" }]),
  f("owner", [], [{ type: "address" }]),
];
const splitAbi = [
  f("recipientCount", [], [{ type: "uint256" }]),
  f("recipients", [{ type: "uint256" }], [{ type: "address" }]),
  f("weightsBps", [{ type: "uint256" }], [{ type: "uint256" }]),
  f("owner", [], [{ type: "address" }]),
];

const ARC_DISTRIBUTOR = "0x7c148B6a581E32CcB6ffF7Bd59AF4250d5ec1eBc";
const ARC_SPLITTER = "0x9d9831cF5dbbC18138234142F622cD22c2AD34f7";
const BASE_SPLITTER = "0x153bbC78B7b7697c12706d423c8c3FA8a2931c29";

async function splitter(client, address, label) {
  console.log(`\n--- ${label}  ${address}`);
  const code = await client.getCode({ address }).catch(() => null);
  if (!code || code === "0x") {
    console.log("    NOT DEPLOYED on this chain");
    return;
  }
  const owner = await client.readContract({ address, abi: splitAbi, functionName: "owner" }).catch((e) => `ERR ${e.shortMessage ?? e.message}`);
  console.log("    owner:", owner);
  const n = await client.readContract({ address, abi: splitAbi, functionName: "recipientCount" }).catch(() => 0n);
  for (let i = 0; i < Number(n); i++) {
    const [r, w] = await Promise.all([
      client.readContract({ address, abi: splitAbi, functionName: "recipients", args: [BigInt(i)] }),
      client.readContract({ address, abi: splitAbi, functionName: "weightsBps", args: [BigInt(i)] }),
    ]);
    console.log(`    ${i}. ${r}  ${Number(w) / 100}%`);
  }
}

(async () => {
  const arc = createPublicClient({ transport: ARC });
  const base = createPublicClient({ transport: BASE });

  console.log("=== ARC mode distributor ===", ARC_DISTRIBUTOR);
  for (const fn of ["protocolTreasury", "creatorShareBps", "owner"]) {
    const v = await arc
      .readContract({ address: ARC_DISTRIBUTOR, abi: distAbi, functionName: fn })
      .catch((e) => `ERR ${(e.shortMessage ?? e.message).split("\n")[0]}`);
    console.log(`    ${fn}:`, typeof v === "bigint" ? v.toString() : v);
  }

  await splitter(arc, ARC_SPLITTER, "ARC splitter");
  await splitter(base, BASE_SPLITTER, "BASE splitter");
})();
