import { createPublicClient, http } from "viem";

const FACTORY = "0x81D414D2cD66bf4422036846f569a6189996Fd59";
const VAULT = "0x4297254E5ae2df2b0d3920A08Df582D61b3e7766";
const DISTRIBUTOR = "0x472580431Fb124e376E8b07802e64d2cEc4001DE";
const GRADUATION = "0x8Ff4Bafacba3fB58d9eB6d2822B1273070442bF3";
const SPLITTER = "0xE886Ca14dbF1D8B729c6F5B081392b4Da3c41a1A";
const FEE_WALLETS = ["0x6bDCaE1573292aadab1fe081142a3f81e8F50A3B","0x7C17a1176CE19d947A0f64c46E1A545d6Aa0a704","0xd5e3D1421e098524B7e1D730Ad9c355483caF3CB","0xdF04c8f699062B8d94f980A1d9d563Adf030e647","0x017f879863Cd169D2d8da21848F43F438bD8AAe3"];
const FEE_WEIGHTS = [4000n,1500n,1500n,1500n,1500n];
const DEPLOYER = "0x582525844FC8D68C5B7515d2199CDd4f72C6816a";

const CHAINS = [
  {
    label: "ROBINHOOD", rpc: "https://rpc.mainnet.chain.robinhood.com",
    quote: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", dec: 6,
    npm: "0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3",
    router: "0xCaf681a66D020601342297493863E78C959E5cb2",
    wantSqrt0: 137227202865029797602n,
    wantSqrt1: 45742400955009932534161870629490520388n,
    wantGrad: 9_000_000_000n,
  },
  {
    label: "BNB", rpc: "https://bsc-dataseed.bnbchain.org",
    quote: "0x55d398326f99059fF775485246999027B3197955", dec: 18,
    npm: "0x7b8A01B39D58278b5DE7e48c8449c9f4F5170613",
    router: "0xB971eF87ede563556b2ED4b1C0b0019111Dd85d2",
    wantSqrt0: 137227202865029797602000000n,
    wantSqrt1: 45742400955009932534161870629490n,
    wantGrad: 9_000n * 10n ** 18n,
  },
];

const A = (n, ins, outs, m = "view") => ({ type: "function", name: n, stateMutability: m, inputs: ins, outputs: outs });
const factoryAbi = [
  A("pairToken", [], [{ type: "address" }]),
  A("modeDistributor", [], [{ type: "address" }]),
  A("liquidityVault", [], [{ type: "address" }]),
  A("positionManager", [], [{ type: "address" }]),
  A("swapRouter", [], [{ type: "address" }]),
  A("owner", [], [{ type: "address" }]),
  A("launchFee", [], [{ type: "uint256" }]),
  A("launchesPaused", [], [{ type: "bool" }]),
  A("POOL_FEE", [], [{ type: "uint24" }]),
  A("allowedPairTokens", [{ type: "address" }], [{ type: "bool" }]),
  A("allTokensLength", [], [{ type: "uint256" }]),
  A("launchPrice", [{ type: "address" }, { type: "bool" }], [{ type: "uint160" }, { type: "int24" }, { type: "int24" }]),
];
const vaultAbi = [A("feeDistributor", [], [{ type: "address" }]), A("owner", [], [{ type: "address" }])];
const distAbi = [
  A("creatorShareBps", [], [{ type: "uint256" }]),
  A("protocolTreasury", [], [{ type: "address" }]),
  A("factory", [], [{ type: "address" }]),
  A("vault", [], [{ type: "address" }]),
  A("owner", [], [{ type: "address" }]),
];
const gradAbi = [A("graduationThreshold", [], [{ type: "uint256" }])];
const splitAbi = [A("recipientCount", [], [{ type: "uint256" }]), A("recipients", [{ type: "uint256" }], [{ type: "address" }]), A("weightsBps", [{ type: "uint256" }], [{ type: "uint256" }])];

let fails = 0;
function check(label, actual, expected) {
  const ok = String(actual).toLowerCase() === String(expected).toLowerCase();
  if (!ok) fails++;
  console.log(`    ${ok ? "PASS" : "FAIL"}  ${label.padEnd(28)} ${actual}${ok ? "" : `   (want ${expected})`}`);
}

for (const c of CHAINS) {
  console.log(`\n===== ${c.label} =====`);
  const client = createPublicClient({ transport: http(c.rpc, { timeout: 25000 }) });
  const r = (address, abi, functionName, args) => client.readContract({ address, abi, functionName, ...(args ? { args } : {}) });

  for (const [n, a] of [["factory", FACTORY], ["vault", VAULT], ["distributor", DISTRIBUTOR], ["graduation", GRADUATION]]) {
    const code = await client.getCode({ address: a });
    check(`${n} deployed`, code && code !== "0x" ? "yes" : "no", "yes");
  }

  check("factory.pairToken", await r(FACTORY, factoryAbi, "pairToken"), c.quote);
  check("factory.modeDistributor", await r(FACTORY, factoryAbi, "modeDistributor"), DISTRIBUTOR);
  check("factory.liquidityVault", await r(FACTORY, factoryAbi, "liquidityVault"), VAULT);
  check("factory.positionManager", await r(FACTORY, factoryAbi, "positionManager"), c.npm);
  check("factory.swapRouter", await r(FACTORY, factoryAbi, "swapRouter"), c.router);
  check("factory.owner", await r(FACTORY, factoryAbi, "owner"), DEPLOYER);
  check("factory.launchFee", await r(FACTORY, factoryAbi, "launchFee"), 0n);
  check("factory.launchesPaused", await r(FACTORY, factoryAbi, "launchesPaused"), false);
  check("factory.POOL_FEE", await r(FACTORY, factoryAbi, "POOL_FEE"), 10000);
  check("quote allowed", await r(FACTORY, factoryAbi, "allowedPairTokens", [c.quote]), true);
  check("allTokensLength", await r(FACTORY, factoryAbi, "allTokensLength"), 0n);

  const [s0] = await r(FACTORY, factoryAbi, "launchPrice", [c.quote, true]);
  const [s1] = await r(FACTORY, factoryAbi, "launchPrice", [c.quote, false]);
  check("launchPrice sqrt (token0)", s0, c.wantSqrt0);
  check("launchPrice sqrt (token1)", s1, c.wantSqrt1);

  check("vault.feeDistributor", await r(VAULT, vaultAbi, "feeDistributor"), DISTRIBUTOR);
  check("vault.owner", await r(VAULT, vaultAbi, "owner"), DEPLOYER);

  check("distributor.creatorShareBps", await r(DISTRIBUTOR, distAbi, "creatorShareBps"), 1000n);
  check("distributor.protocolTreasury", await r(DISTRIBUTOR, distAbi, "protocolTreasury"), SPLITTER);
  check("splitter.recipientCount", await r(SPLITTER, splitAbi, "recipientCount"), 5n);
  for (let i = 0; i < 5; i++) {
    check(`  splitter wallet ${i}`, await r(SPLITTER, splitAbi, "recipients", [BigInt(i)]), FEE_WALLETS[i]);
    check(`  splitter weight ${i}`, await r(SPLITTER, splitAbi, "weightsBps", [BigInt(i)]), FEE_WEIGHTS[i]);
  }
  check("distributor.factory", await r(DISTRIBUTOR, distAbi, "factory"), FACTORY);
  check("distributor.vault", await r(DISTRIBUTOR, distAbi, "vault"), VAULT);
  check("distributor.owner", await r(DISTRIBUTOR, distAbi, "owner"), DEPLOYER);

  const grad = await r(GRADUATION, gradAbi, "graduationThreshold").catch(() => null);
  if (grad !== null) check("graduationThreshold", grad, c.wantGrad);
}

console.log(`\n${fails === 0 ? "ALL CHECKS PASSED" : `${fails} CHECK(S) FAILED`}`);
process.exit(fails === 0 ? 0 : 1);
