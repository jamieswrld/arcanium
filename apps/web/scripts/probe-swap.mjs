import { createPublicClient, http } from "viem";

/** Which native<->stable pools actually exist, and where the liquidity is. */
const CHAINS = [
  {
    label: "ROBINHOOD", rpc: "https://rpc.mainnet.chain.robinhood.com",
    npm: "0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3",
    uniFactory: "0x1f7d7550B1b028f7571E69A784071F0205FD2EfA",
    stable: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", stableSym: "USDG",
  },
  {
    label: "BNB", rpc: "https://bsc-dataseed.bnbchain.org",
    npm: "0x7b8A01B39D58278b5DE7e48c8449c9f4F5170613",
    uniFactory: "0xdB1d10011AD0Ff90774D0C6Bb92e5C5c8b4461F7",
    stable: "0x55d398326f99059fF775485246999027B3197955", stableSym: "USDT",
  },
];

const f = (n, i, o) => ({ type: "function", name: n, stateMutability: "view", inputs: i, outputs: o });
const npmAbi = [f("WETH9", [], [{ type: "address" }])];
const facAbi = [f("getPool", [{ type: "address" }, { type: "address" }, { type: "uint24" }], [{ type: "address" }])];
const poolAbi = [f("liquidity", [], [{ type: "uint128" }])];
const ercAbi = [f("symbol", [], [{ type: "string" }]), f("decimals", [], [{ type: "uint8" }]),
                f("balanceOf", [{ type: "address" }], [{ type: "uint256" }])];

for (const c of CHAINS) {
  const cl = createPublicClient({ transport: http(c.rpc, { timeout: 25000 }) });
  console.log(`\n===== ${c.label} =====`);
  const weth = await cl.readContract({ address: c.npm, abi: npmAbi, functionName: "WETH9" });
  const [wsym, wdec] = await Promise.all([
    cl.readContract({ address: weth, abi: ercAbi, functionName: "symbol" }),
    cl.readContract({ address: weth, abi: ercAbi, functionName: "decimals" }),
  ]);
  console.log(`  wrapped native: ${weth}  ${wsym} (${wdec}dp)`);

  for (const fee of [100, 500, 3000, 10000]) {
    const pool = await cl.readContract({
      address: c.uniFactory, abi: facAbi, functionName: "getPool", args: [weth, c.stable, fee],
    });
    if (pool === "0x0000000000000000000000000000000000000000") {
      console.log(`    fee ${String(fee).padStart(5)}  no pool`);
      continue;
    }
    const [liq, wBal, sBal] = await Promise.all([
      cl.readContract({ address: pool, abi: poolAbi, functionName: "liquidity" }).catch(() => 0n),
      cl.readContract({ address: weth, abi: ercAbi, functionName: "balanceOf", args: [pool] }).catch(() => 0n),
      cl.readContract({ address: c.stable, abi: ercAbi, functionName: "balanceOf", args: [pool] }).catch(() => 0n),
    ]);
    console.log(
      `    fee ${String(fee).padStart(5)}  pool ${pool}  liq=${liq}  ` +
      `${(Number(wBal) / 10 ** Number(wdec)).toFixed(3)} ${wsym} / ` +
      `${(Number(sBal) / 1e18 * (c.stableSym === "USDG" ? 1e12 : 1)).toFixed(2)} ${c.stableSym}`,
    );
  }
}
