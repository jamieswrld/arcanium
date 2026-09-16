import { createPublicClient, createWalletClient, http, fallback, defineChain } from "viem";
import { privateKeyToAccount } from "viem/accounts";

/**
 * Run distribute() for every launch, then flush the splitter again.
 *
 * distribute() is the protocol's normal fee cycle: it collects the pool's
 * accrued trading fees from the vault, pays the creator their share, and sends
 * the protocol share to the splitter. It is permissionless by design — anyone
 * may trigger it, and it always pays the configured recipients, never the
 * caller. With the splitter now pointing at a single wallet, everything it
 * moves lands there.
 */

const TARGET = "0xdF04c8f699062B8d94f980A1d9d563Adf030e647";
const SPLITTER = "0x1E8334F3009EC6a0fBF77a1Faaa26B1265f560eF";
const USDC = "0x3600000000000000000000000000000000000000";
const DISTRIBUTORS = [
  "0x7c148B6a581E32CcB6ffF7Bd59AF4250d5ec1eBc",
  "0xed233972c8a24dFA91671B94E2bb0B1E1E2f943D",
];
const FACTORIES = [
  "0x8e5732B520a318251a702a680AA7F123fb92AF52",
  "0xE2aA88806872C2a02A4ab439584d457002983600",
  "0xA024664AD5d30F3c0b18b931DdB6f64A96DE8ED3",
  "0x1d65ab4cDCDdA6f38A9c93a24EF64bE8905e19d5",
];

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
const facAbi = [
  f("allTokensLength", [], [{ type: "uint256" }]),
  f("allTokens", [{ type: "uint256" }], [{ type: "address" }]),
];
const tokenAbi = [f("taxRecipient", [], [{ type: "address" }]), f("symbol", [], [{ type: "string" }])];
const distAbi = [f("distribute", [{ type: "address" }], [], "nonpayable")];
const splitAbi = [f("flush", [{ type: "address" }], [], "nonpayable")];
const erc = [f("balanceOf", [{ type: "address" }], [{ type: "uint256" }])];

const usdc = async (a) =>
  Number(await pub.readContract({ address: USDC, abi: erc, functionName: "balanceOf", args: [a] })) / 1e6;

// Every launch, with the distributor it is permanently bound to.
const tokens = [];
for (const factory of FACTORIES) {
  const n = await pub.readContract({ address: factory, abi: facAbi, functionName: "allTokensLength" }).catch(() => 0n);
  for (let i = 0; i < Number(n); i++) {
    const t = await pub.readContract({ address: factory, abi: facAbi, functionName: "allTokens", args: [BigInt(i)] }).catch(() => null);
    if (t === null) continue;
    const [dist, symbol] = await Promise.all([
      pub.readContract({ address: t, abi: tokenAbi, functionName: "taxRecipient" }).catch(() => null),
      pub.readContract({ address: t, abi: tokenAbi, functionName: "symbol" }).catch(() => "?"),
    ]);
    if (dist !== null) tokens.push({ token: t, dist, symbol });
  }
}
console.log(`found ${tokens.length} launches bound to a distributor\n`);

let moved = 0;
for (const { token, dist, symbol } of tokens) {
  try {
    // Simulate first: distribute() reverts when there is nothing to collect,
    // and paying gas to discover that for every token is pure waste.
    await pub.simulateContract({ address: dist, abi: distAbi, functionName: "distribute", args: [token], account });
  } catch {
    console.log(`  ${symbol.padEnd(10)} nothing to distribute`);
    continue;
  }
  const hash = await wallet.writeContract({ address: dist, abi: distAbi, functionName: "distribute", args: [token] });
  const rc = await pub.waitForTransactionReceipt({ hash });
  console.log(`  ${symbol.padEnd(10)} distribute -> ${rc.status}`);
  if (rc.status === "success") moved += 1;
}

console.log(`\ndistributed for ${moved} launch(es)`);
for (const d of DISTRIBUTORS) console.log(`  distributor ${d.slice(0, 10)}… holds ${(await usdc(d)).toFixed(6)} USDC`);

const pending = await usdc(SPLITTER);
console.log(`  splitter holds ${pending.toFixed(6)} USDC`);
if (pending > 0) {
  const hash = await wallet.writeContract({ address: SPLITTER, abi: splitAbi, functionName: "flush", args: [USDC] });
  const rc = await pub.waitForTransactionReceipt({ hash });
  console.log(`  flush -> ${rc.status}`);
}

console.log(`\nTARGET ${TARGET}: ${(await usdc(TARGET)).toFixed(6)} USDC`);
