import { createPublicClient, createWalletClient, http, fallback, defineChain } from "viem";
import { privateKeyToAccount } from "viem/accounts";

/**
 * Point all protocol fees at a single wallet, then sweep what has accrued.
 *
 * Order matters: recipients are changed FIRST, so the flush that follows sends
 * the whole balance to the new sole recipient. Flushing first would pay the
 * outgoing 40/15/15/15/15 split instead.
 *
 * Both distributors already route into this splitter, so one change covers
 * every fee stream — current and any future distributor pointed here.
 */

const TARGET = "0xdF04c8f699062B8d94f980A1d9d563Adf030e647";
const SPLITTER = "0x1E8334F3009EC6a0fBF77a1Faaa26B1265f560eF";
const USDC = "0x3600000000000000000000000000000000000000";

const arc = defineChain({
  id: 5042,
  name: "Arc",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.arc-scan.org"] } },
});

const transport = fallback(
  ["https://rpc.arc-scan.org", "https://rpc.blockdaemon.mainnet.arc.io"].map((u) =>
    http(u, { timeout: 20_000, retryCount: 2 }),
  ),
);

const raw = process.env.DEPLOYER_PRIVATE_KEY.trim();
const account = privateKeyToAccount(raw.startsWith("0x") ? raw : `0x${raw}`);
const pub = createPublicClient({ chain: arc, transport });
const wallet = createWalletClient({ account, chain: arc, transport });

const f = (n, i, o, s = "view") => ({ type: "function", name: n, stateMutability: s, inputs: i, outputs: o });
const splitAbi = [
  f("setRecipients", [{ type: "address[]" }, { type: "uint256[]" }], [], "nonpayable"),
  f("flush", [{ type: "address" }], [], "nonpayable"),
  f("recipientCount", [], [{ type: "uint256" }]),
  f("recipients", [{ type: "uint256" }], [{ type: "address" }]),
  f("weightsBps", [{ type: "uint256" }], [{ type: "uint256" }]),
];
const erc = [f("balanceOf", [{ type: "address" }], [{ type: "uint256" }])];

const usdc = async (a) =>
  Number(await pub.readContract({ address: USDC, abi: erc, functionName: "balanceOf", args: [a] })) / 1e6;

async function show(label) {
  const n = await pub.readContract({ address: SPLITTER, abi: splitAbi, functionName: "recipientCount" });
  const rows = [];
  for (let i = 0; i < Number(n); i++) {
    const [r, w] = await Promise.all([
      pub.readContract({ address: SPLITTER, abi: splitAbi, functionName: "recipients", args: [BigInt(i)] }),
      pub.readContract({ address: SPLITTER, abi: splitAbi, functionName: "weightsBps", args: [BigInt(i)] }),
    ]);
    rows.push(`${r} ${Number(w) / 100}%`);
  }
  console.log(`  ${label}: ${rows.join("  |  ")}`);
}

async function send(functionName, args, label) {
  const hash = await wallet.writeContract({ address: SPLITTER, abi: splitAbi, functionName, args });
  const rc = await pub.waitForTransactionReceipt({ hash });
  console.log(`  ${label}: ${rc.status}  ${hash}`);
  if (rc.status !== "success") throw new Error(`${label} reverted`);
}

console.log("BEFORE");
await show("recipients");
console.log("  splitter balance:", (await usdc(SPLITTER)).toFixed(6), "USDC");
console.log("  target balance:  ", (await usdc(TARGET)).toFixed(6), "USDC");

console.log("\nSTEP 1 — route 100% of fees to one wallet");
await send("setRecipients", [[TARGET], [10_000n]], "setRecipients");
await show("recipients now");

console.log("\nSTEP 2 — sweep the accrued balance to that wallet");
await send("flush", [USDC], "flush");

console.log("\nAFTER");
console.log("  splitter balance:", (await usdc(SPLITTER)).toFixed(6), "USDC");
console.log("  target balance:  ", (await usdc(TARGET)).toFixed(6), "USDC");
