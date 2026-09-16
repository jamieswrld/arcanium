/**
 * Arcanium's deployed contracts on Arc (chain 5042).
 *
 * This is the canonical list. Every address here was read back from chain, not
 * copied from a previous file — which mattered, because the manifest this
 * replaces disagreed with reality in three ways:
 *
 *   - it named 0x164aBB4D… as the current mode distributor. That contract is
 *     deployed but used by zero launches; the one it labelled "old"
 *     (0x7c148B6a…) is the one 9 launches actually pay into.
 *   - it named the v3 factory as "factory" while v4, with the most launches,
 *     was listed separately as "factoryV4".
 *   - it omitted the 0xed233972… distributor entirely, which 2 launches use.
 *
 * A stale address in a shared file is worse than no file: it is the version
 * everyone trusts. So the rule here is that nothing gets added without being
 * verified on chain first, and CURRENT vs LEGACY is stated rather than implied
 * by ordering or naming.
 *
 * LEGACY does not mean dead. Every legacy factory's tokens stay listed,
 * tradable and collectable forever, and every legacy distributor still holds
 * the fee streams of the launches bound to it — a token's taxRecipient is
 * immutable, so those bindings can never be migrated. Legacy means "do not
 * launch anything new against this", nothing more.
 */

export const ARC_CHAIN_ID = 5042 as const;

export type Address = `0x${string}`;

/**
 * Launchpad factory generations, newest first.
 *
 * Tokens are never dropped when a generation is superseded, so discovery has
 * to read all of them. Counts are from chain at the time of writing and will
 * drift; they are here to make "which one is real" answerable at a glance.
 */
export const ARC_FACTORIES = {
  current: "0x8e5732B520a318251a702a680AA7F123fb92AF52" as Address, // v4 — launch modes
  legacy: [
    "0xE2aA88806872C2a02A4ab439584d457002983600", // v3 — fee recipient
    "0xA024664AD5d30F3c0b18b931DdB6f64A96DE8ED3", // v2 — SwapRouter02 fix
    "0x1d65ab4cDCDdA6f38A9c93a24EF64bE8905e19d5", // v1 — original
  ] as readonly Address[],
} as const;

/** Every generation, newest first — what discovery and indexing should walk. */
export const ARC_ALL_FACTORIES: readonly Address[] = [
  ARC_FACTORIES.current,
  ...ARC_FACTORIES.legacy,
];

/**
 * Fee distributors. A launch's taxRecipient is immutable, so which distributor
 * a token uses is fixed at launch and every generation must keep being swept.
 */
export const ARC_DISTRIBUTORS = {
  current: "0x7c148B6a581E32CcB6ffF7Bd59AF4250d5ec1eBc" as Address,
  legacy: [
    "0xed233972c8a24dFA91671B94E2bb0B1E1E2f943D",
    "0x789896401c1c90dF95757dFd3228989B627418b4",
    "0xbdc362f9ddEA2ae9C39b108E0712F7d6e2f00e5F",
  ] as readonly Address[],
} as const;

export const ARC_ALL_DISTRIBUTORS: readonly Address[] = [
  ARC_DISTRIBUTORS.current,
  ...ARC_DISTRIBUTORS.legacy,
];

/**
 * Deployed but unused. Kept named so nobody rediscovers it and assumes it is
 * live — it was recorded as the current distributor in the old manifest while
 * no launch has ever pointed at it.
 */
export const ARC_UNUSED_DISTRIBUTOR = "0x164aBB4Dc85C2Ff20B0AFE22D7Db7fcbEBdcf736" as Address;

/** Protocol fee routing. The splitter is what distributors pay the protocol
 *  share into; flushing it pays the recipients. */
export const ARC_FEE_SPLITTER = "0x1E8334F3009EC6a0fBF77a1Faaa26B1265f560eF" as Address;

/** Holds each launch's permanently locked Uniswap v3 position. */
export const ARC_LIQUIDITY_VAULT = "0x94e8335bED5585f3F43899505B5e5968fa11185E" as Address;

export const ARC_GRADUATION_REGISTRY = "0xC73d4b6Bd63F0ee69514768870D74548F4d12bc6" as Address;

/**
 * Token locker. Deployed 2026-09-17. No owner, no admin unlock, not upgradeable.
 * Unrelated to ARC_LIQUIDITY_VAULT, which holds launch liquidity forever — this
 * holds ordinary user allocation locks with a beneficiary and an end date.
 */
export const ARC_TOKEN_LOCKER = "0x0aB1fbD6c01f4908f509746393DE25849aE2a9E7" as Address;

/** Block the locker was deployed in. Indexing it from the launchpad's start
 *  block would mean ~8.4M pointless chunks against a contract that did not
 *  exist, most of them in ranges Arc's RPCs have already pruned. */
export const ARC_TOKEN_LOCKER_BLOCK = 21_170_030n;

/**
 * X creator vaults. The factory deploys minimal proxies at CREATE2 addresses
 * derived from the X identity alone, so a vault address is usable as a launch's
 * fee recipient before the vault itself exists.
 *
 * An earlier deployment keyed vaults on (identity, token). That could not work:
 * a launch needs a fee recipient at creation time, and the token's address does
 * not exist until the factory mints it, so the address was underivable exactly
 * when it was needed. Replaced before anything used it — zero vaults had been
 * deployed and no launch referenced one.
 */
export const ARC_XCREATOR = {
  factory: "0xae74c38757558C63BD1489056e436dc06F74DFd6" as Address,
  implementation: "0x416F3dc785e0B6715e1629630c6F99f57de1FAb6" as Address,
  /** Whose EIP-712 attestations vaults accept. Rotatable by the factory owner;
   *  its private key lives only in server-side env. */
  attestationSigner: "0x74E6853252D79608054c71bb6c90BF1D381932E5" as Address,
  /** Block the factory was deployed in. */
  deployedBlock: 21_190_000n,
} as const;

/**
 * The Uniswap v3 deployment Arcanium's pools live on — not ours. Deployed
 * ~10.8M blocks before the first launchpad and owned by 0xbCA30b54…, so
 * Arcanium is a launchpad built on it rather than a DEX of its own.
 *
 * Note it is *undocumented*: Arc is not listed in Uniswap's published v3
 * deployments, though the same address owns this factory and the official v4
 * PoolManager below. Aggregators key off the documented deployment, which is
 * why our pools can stay unroutable even once Arc is well indexed.
 */
export const ARC_UNISWAP = {
  factory: "0xf0db7b58379503491d857dB50AC9ece64c653918" as Address,
  positionManager: "0x39654A85A4C05127f5Fd6ED22CAeC077A0fB1377" as Address,
  swapRouter: "0x4C91c54E60B59b1F949Af57064EA70bD73434720" as Address,
  /** Fee tier every launch pool uses: 1%, tickSpacing 200. */
  poolFee: 10_000,
} as const;

/**
 * Uniswap v4 on Arc, official and documented, live since 2026-09-16.
 *
 * Arcanium does not use these yet: every existing launch holds a v3 position
 * that is locked forever and cannot be moved. Recorded because any question
 * about routing, aggregator coverage or a future launch venue starts here.
 */
/**
 * Arcanium's own v4 contracts.
 *
 * The hook's address is not arbitrary and not chosen: v4 reads a hook's
 * permissions out of the low 14 bits of its address, so the salt is mined
 * until CREATE2 lands on one carrying exactly the flags the contract declares.
 * 0x…2044 is beforeInitialize | afterSwap | afterSwapReturnsDelta. Because it
 * is CREATE2 through the canonical proxy, the address is fixed by the bytecode
 * and the constructor arguments — redeploying the same contract with the same
 * arguments lands on the same address anywhere.
 *
 * The launchpad is plain CREATE, so its address depends on the deployer's
 * nonce and has to be recorded rather than derived. Both are `undefined` until
 * deployed, and every consumer treats that as "v4 is not available yet" rather
 * than falling back to something.
 */
export const ARC_ARCANIUM_V4: {
  readonly hook: Address;
  readonly launchpad: Address;
  readonly poolFee: number;
  readonly tickSpacing: number;
} = {
  hook: "0x558d402371153231920C4cA64a1092ad8231A044" as Address,
  launchpad: "0xA5316d41EfA1473041430fdB19eDFd1165a47878" as Address,
  /** Pools open with no LP fee; the hook takes 1% inside the swap instead. */
  poolFee: 0,
  tickSpacing: 200,
};

/**
 * The flywheel. Receives a share of protocol fees from the splitter, buys
 * ARCANIUM with it and burns it.
 *
 * No owner, no withdraw, no rescue, no pause. USDC that arrives has exactly one
 * exit — through the pool into 0xdead — which is the point of sending fees to a
 * contract rather than to a wallet that intends the same thing.
 */
export const ARC_BUYBACK = "0x92651195749132B6C631C88E5b2f405F7BEF80F0" as Address;

/** Block the v4 launchpad was deployed in, and the floor for its backfill. */
export const ARC_LAUNCHPAD_V4_BLOCK = 21_223_800n;

export const ARC_UNISWAP_V4 = {
  poolManager: "0x8366a39CC670B4001A1121B8F6A443A643e40951" as Address,
  positionManager: "0x6049c9a0e26405C0985f9E3685C87d0aE917f82B" as Address,
  universalRouter: "0x4fcA4a51Ab4F23A7447b3284fBd7D73289A89Fb1" as Address,
  stateView: "0xF3334192D15450CdD385c8B70e03f9A6bD9E673b" as Address,
  quoter: "0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94" as Address,
} as const;

/** Arc's native USDC, as a 6-decimal ERC-20 view of the 18-decimal gas token. */
export const ARC_USDC = "0x3600000000000000000000000000000000000000" as Address;

export const ARC_MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11" as Address;

/** Where protocol fees end up once the splitter is flushed. */
export const ARC_FEE_TREASURY = "0xdF04c8f699062B8d94f980A1d9d563Adf030e647" as Address;

/** Block the oldest factory was deployed in — the floor for any backfill. */
export const ARC_FIRST_LAUNCH_BLOCK = 12_775_070n;
