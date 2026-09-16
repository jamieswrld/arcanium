import pino from "pino";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  fallback,
  formatUnits,
  http,
  type Hex,
  type Chain,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

/**
 * Fee keeper: makes Divium dividends and Arcane burns happen on their own.
 *
 * Neither mode is self-executing, and that is a property of Uniswap v3 rather
 * than a gap in our contracts. A pool's trading fees sit uncollected until
 * someone calls `collect`, so `distribute(token)` has to be invoked by
 * somebody. Until now that somebody was a person running a script, which means
 * holders were paid and tokens were burned only when one of us remembered.
 *
 * `distribute` is permissionless and always pays the *configured* recipients —
 * the creator, the holders, the burn address, the treasury — never the caller.
 * So this process cannot take anything. Its wallet needs gas and nothing else,
 * and a compromise of its key costs exactly that gas.
 *
 * It runs as its own service rather than inside the indexer on purpose. The
 * indexer holds no signing key and can only read; keeping it that way is worth
 * more than sharing a process.
 */

const log = pino({ level: process.env["LOG_LEVEL"] ?? "info", name: "arch-keeper" });

/** How often to sweep every launch. */
const INTERVAL_MS = Number(process.env["KEEPER_INTERVAL_MS"] ?? 15 * 60_000);

/** Pause between sends, so a sweep does not arrive as one burst. */
const SEND_GAP_MS = 1_500;

/**
 * Warn below this much gas. Arc's gas token is USDC at 18 decimals, and a full
 * sweep of everything currently collectable measured ~0.018.
 */
const LOW_BALANCE = 2n * 10n ** 18n;

const DEFAULT_FACTORIES = [
  "0x8e5732B520a318251a702a680AA7F123fb92AF52", // v4 — launch modes
  "0xE2aA88806872C2a02A4ab439584d457002983600", // v3 — fee recipient
  "0xA024664AD5d30F3c0b18b931DdB6f64A96DE8ED3", // v2 — SwapRouter02 fix
  "0x1d65ab4cDCDdA6f38A9c93a24EF64bE8905e19d5", // v1 — original
] as const;

const fn = (
  name: string,
  inputs: readonly { type: string }[],
  outputs: readonly { type: string }[],
  stateMutability = "view",
) => ({ type: "function" as const, name, stateMutability, inputs, outputs });

const factoryAbi = [
  fn("allTokensLength", [], [{ type: "uint256" }]),
  fn("allTokens", [{ type: "uint256" }], [{ type: "address" }]),
] as const;

const tokenAbi = [
  fn("taxRecipient", [], [{ type: "address" }]),
  fn("symbol", [], [{ type: "string" }]),
] as const;

const distributorAbi = [fn("distribute", [{ type: "address" }], [], "nonpayable")] as const;

const splitterAbi = [fn("flush", [{ type: "address" }], [], "nonpayable")] as const;

const erc20Abi = [fn("balanceOf", [{ type: "address" }], [{ type: "uint256" }])] as const;

/** The splitter every distributor pays the protocol share into. */
const DEFAULT_SPLITTER = "0x1E8334F3009EC6a0fBF77a1Faaa26B1265f560eF";
/** Arc's native USDC, the asset fees arrive in. */
const QUOTE = "0x3600000000000000000000000000000000000000";

/**
 * Push the splitter's balance out to its recipients.
 *
 * distribute() only moves fees as far as the splitter; flush() is what pays
 * them onward, and it is permissionless and has to be called too. Sweeping
 * distribute alone leaves money piling up one hop short of where it is going —
 * 304 USDC had accumulated there before this existed.
 *
 * Simulated first like everything else: flush reverts on a zero balance, which
 * is the normal state right after a successful one.
 */
async function flushSplitter(
  arc: PublicClient,
  wallet: WalletClient,
  chain: Chain,
  caller: Hex,
  splitter: Hex,
): Promise<void> {
  // Cast, because the `fn` helper above builds ABIs too loosely for viem to
  // infer a return type from — the same reason the reads elsewhere here cast.
  const pending = (await arc
    .readContract({ address: QUOTE, abi: erc20Abi, functionName: "balanceOf", args: [splitter] })
    .catch(() => 0n)) as bigint;
  if (pending === 0n) return;

  try {
    await arc.simulateContract({
      address: splitter,
      abi: splitterAbi,
      functionName: "flush",
      args: [QUOTE],
      account: caller,
    });
  } catch {
    return;
  }

  const hash = await wallet.writeContract({
    address: splitter,
    abi: splitterAbi,
    functionName: "flush",
    args: [QUOTE],
    chain,
    account: wallet.account ?? null,
  });
  const receipt = await arc.waitForTransactionReceipt({ hash, timeout: 120_000 });
  log.info(
    { pending: formatUnits(pending, 6), status: receipt.status, hash },
    "flushed splitter to its recipients",
  );
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function required(name: string): string {
  const v = process.env[name];
  if (v === undefined || v.trim() === "") throw new Error(`${name} is required`);
  return v.trim();
}

/**
 * Every launch, read from the factories rather than from logs.
 *
 * `allTokens` is a direct call, so this keeps working across Arc's log pruning —
 * a log-derived list would quietly lose the oldest launches, and those are
 * exactly the ones most likely to have fees nobody has swept.
 */
async function everyLaunch(arc: PublicClient, factories: readonly Hex[]): Promise<Hex[]> {
  const found: Hex[] = [];
  for (const factory of factories) {
    const count = await arc
      .readContract({ address: factory, abi: factoryAbi, functionName: "allTokensLength" })
      .catch(() => 0n);
    const reads = await Promise.all(
      Array.from({ length: Number(count) }, (_, i) =>
        arc
          .readContract({ address: factory, abi: factoryAbi, functionName: "allTokens", args: [BigInt(i)] })
          .catch(() => null),
      ),
    );
    for (const t of reads) if (t !== null) found.push(t as Hex);
  }
  // A token can be listed by more than one generation; distributing twice in a
  // cycle would just waste the second call's gas on a revert.
  return [...new Set(found.map((t) => t.toLowerCase()))] as Hex[];
}

interface Candidate {
  readonly token: Hex;
  readonly symbol: string;
  readonly distributor: Hex;
}

/**
 * Every distributor a launch might be bound to, newest first.
 *
 * A token's taxRecipient is immutable, so which distributor it pays into is
 * fixed at launch and every generation has to keep being swept.
 */
const DISTRIBUTORS: readonly Hex[] = (
  process.env["KEEPER_DISTRIBUTORS"] ??
  "0x7c148B6a581E32CcB6ffF7Bd59AF4250d5ec1eBc," +
  "0xed233972c8a24dFA91671B94E2bb0B1E1E2f943D," +
  "0x789896401c1c90dF95757dFd3228989B627418b4," +
  "0xbdc362f9ddEA2ae9C39b108E0712F7d6e2f00e5F"
)
  .split(",")
  .map((a) => a.trim())
  .filter((a) => /^0x[0-9a-fA-F]{40}$/.test(a)) as Hex[];

/** Cache, so a token's distributor is discovered once rather than every cycle. */
const distributorOf = new Map<string, Hex | null>();

/** The launches whose distribute() would actually do something right now. */
async function collectable(arc: PublicClient, tokens: readonly Hex[], caller: Hex): Promise<Candidate[]> {
  const out: Candidate[] = [];
  for (const token of tokens) {
    // Ask the token first — but only launches from the v4 factory answer.
    // Everything minted by v1, v2 or v3 reverts on taxRecipient, and the old
    // code treated that as "skip", so those launches were never swept at all:
    // their dividends never arrived and their burns never happened. When the
    // token cannot say, every known distributor is tried instead.
    const cachedKey = token.toLowerCase();
    const cached = distributorOf.get(cachedKey);
    const named = cached !== undefined
      ? cached
      : ((await arc
          .readContract({ address: token, abi: tokenAbi, functionName: "taxRecipient" })
          .catch(() => null)) as Hex | null);

    const candidates: readonly Hex[] = named !== null ? [named] : DISTRIBUTORS;

    // Simulate first. distribute() reverts when there is nothing to collect,
    // which is the normal state for most launches most of the time — paying gas
    // to discover that for every token every cycle would be pure waste. It
    // also reverts for a distributor that does not know the token, which is
    // what makes this double as the lookup.
    let hit: Hex | null = null;
    for (const d of candidates) {
      const ok = await arc
        .simulateContract({
          address: d,
          abi: distributorAbi,
          functionName: "distribute",
          args: [token],
          account: caller,
        })
        .then(() => true)
        .catch(() => false);
      if (ok) { hit = d; break; }
    }

    if (named !== null) distributorOf.set(cachedKey, named);
    else if (hit !== null) distributorOf.set(cachedKey, hit);

    if (hit === null) continue;

    const symbol = await arc
      .readContract({ address: token, abi: tokenAbi, functionName: "symbol" })
      .catch(() => "?");
    out.push({ token, symbol: symbol as string, distributor: hit });
  }
  return out;
}

async function sweep(
  arc: PublicClient,
  wallet: WalletClient,
  chain: Chain,
  caller: Hex,
  factories: readonly Hex[],
  splitter: Hex,
): Promise<void> {
  const balance = await arc.getBalance({ address: caller });
  if (balance < LOW_BALANCE) {
    log.warn(
      { balance: formatUnits(balance, 18), address: caller },
      "keeper wallet is low on gas — dividends and burns stop when it runs out",
    );
  }
  if (balance === 0n) return;

  const tokens = await everyLaunch(arc, factories);
  const ready = await collectable(arc, tokens, caller);
  if (ready.length === 0) {
    log.info({ launches: tokens.length }, "nothing to distribute");
    // Still flush: a previous cycle may have distributed into the splitter and
    // then failed to push it onward, and nothing else ever retries that.
    await flushSplitter(arc, wallet, chain, caller, splitter).catch((err: unknown) =>
      log.warn({ err }, "flush failed"),
    );
    return;
  }

  let done = 0;
  for (const c of ready) {
    try {
      // The real chain, not null. Passing null tells viem to skip its chain-id
      // check, which is exactly the check worth keeping on a process that signs
      // unattended — a wallet pointed at the wrong network should fail loudly
      // rather than broadcast somewhere unintended.
      const hash = await wallet.writeContract({
        address: c.distributor,
        abi: distributorAbi,
        functionName: "distribute",
        args: [c.token],
        chain,
        account: wallet.account ?? null,
      });
      const receipt = await arc.waitForTransactionReceipt({ hash, timeout: 120_000 });
      if (receipt.status === "success") done += 1;
      log.info({ symbol: c.symbol, token: c.token, status: receipt.status, hash }, "distributed");
    } catch (err) {
      // One launch failing must not stop the rest: they are independent, and a
      // revert here usually means someone else swept it moments earlier.
      log.warn({ err, symbol: c.symbol, token: c.token }, "distribute failed");
    }
    await sleep(SEND_GAP_MS);
  }
  // After distributing, the protocol share sits in the splitter. Push it on.
  await flushSplitter(arc, wallet, chain, caller, splitter).catch((err: unknown) =>
    log.warn({ err }, "flush failed"),
  );
  log.info({ distributed: done, ready: ready.length, launches: tokens.length }, "sweep complete");
}

async function main(): Promise<void> {
  const rpcs = (process.env["ARC_RPC_URLS"] ?? "https://rpc.quicknode.mainnet.arc.io")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");

  const raw = required("KEEPER_PRIVATE_KEY");
  const account = privateKeyToAccount((raw.startsWith("0x") ? raw : `0x${raw}`) as Hex);

  const chain = defineChain({
    id: 5042,
    name: "Arc",
    nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
    rpcUrls: { default: { http: [...rpcs] } },
    contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } },
  });

  const transport = fallback(rpcs.map((u) => http(u, { timeout: 20_000, retryCount: 2 })));
  const arc = createPublicClient({ chain, transport }) as PublicClient;
  const wallet = createWalletClient({ account, chain, transport });

  const factories = (process.env["ARCH_LAUNCHPAD_FACTORIES"] ?? DEFAULT_FACTORIES.join(","))
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^0x[0-9a-fA-F]{40}$/.test(s)) as Hex[];

  const splitter = (process.env["ARCH_FEE_SPLITTER_ADDRESS"] ?? DEFAULT_SPLITTER) as Hex;

  log.info(
    { keeper: account.address, factories: factories.length, splitter, intervalMs: INTERVAL_MS, rpcs },
    "keeper starting",
  );

  for (;;) {
    try {
      await sweep(arc, wallet, chain, account.address, factories, splitter);
    } catch (err) {
      // Never exit. A sweep that fails wholesale is almost always the RPC
      // having a moment, and the next cycle will pick up everything missed.
      log.error({ err }, "sweep failed; retrying next cycle");
    }
    await sleep(INTERVAL_MS);
  }
}

main().catch((err: unknown) => {
  log.error({ err }, "keeper died");
  process.exit(1);
});
