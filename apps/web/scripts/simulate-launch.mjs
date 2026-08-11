import { createPublicClient, http } from "viem";

/**
 * Dry-run a real launch against the DEPLOYED factories via eth_call. Nothing is
 * broadcast and no token is created, but the call executes the whole path —
 * token deploy, pool create + initialize, single-sided mint into the vault,
 * setMode on the distributor — against live chain state. If a decimals or
 * wiring mistake survived, this reverts.
 */
const FACTORY = "0x81D414D2cD66bf4422036846f569a6189996Fd59";
const CALLER = "0x582525844FC8D68C5B7515d2199CDd4f72C6816a";

const abi = [{
  type: "function", name: "launch", stateMutability: "nonpayable",
  inputs: [{
    type: "tuple", name: "params", components: [
      { name: "name", type: "string" }, { name: "symbol", type: "string" },
      { name: "metadataUri", type: "string" }, { name: "pairToken", type: "address" },
      { name: "creatorBuyAmount", type: "uint256" }, { name: "minTokensOut", type: "uint256" },
      { name: "deadline", type: "uint256" }, { name: "feeRecipient", type: "address" },
      { name: "taxBps", type: "uint256" }, { name: "mode", type: "uint8" },
    ],
  }],
  outputs: [{ type: "address" }, { type: "address" }, { type: "uint256" }],
}];

const CHAINS = [
  { label: "ROBINHOOD", rpc: "https://rpc.mainnet.chain.robinhood.com", quote: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" },
  { label: "BNB", rpc: "https://bsc-dataseed.bnbchain.org", quote: "0x55d398326f99059fF775485246999027B3197955" },
];

let fails = 0;
for (const c of CHAINS) {
  const client = createPublicClient({ transport: http(c.rpc, { timeout: 30000 }) });
  const now = await client.getBlock().then((b) => b.timestamp);
  console.log(`\n===== ${c.label} =====`);
  for (const [modeName, mode] of [["standard", 0], ["divium", 1], ["arcane", 2]]) {
    try {
      const { result } = await client.simulateContract({
        address: FACTORY, abi, functionName: "launch", account: CALLER,
        args: [{
          name: "Verification", symbol: "VERIFY", metadataUri: "",
          pairToken: c.quote, creatorBuyAmount: 0n, minTokensOut: 0n,
          deadline: now + 600n, feeRecipient: CALLER, taxBps: 0n, mode,
        }],
      });
      console.log(`    PASS  ${modeName.padEnd(9)} -> token ${result[0]}  pool ${result[1]}`);
    } catch (e) {
      fails++;
      console.log(`    FAIL  ${modeName.padEnd(9)} -> ${(e.shortMessage ?? e.message).split("\n")[0]}`);
    }
  }
}
console.log(`\n${fails === 0 ? "ALL LAUNCH PATHS SIMULATE CLEAN" : `${fails} FAILED`}`);
process.exit(fails === 0 ? 0 : 1);
