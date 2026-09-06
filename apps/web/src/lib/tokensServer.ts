import "server-only";
import { arcPublicClient, fetchAllTokens, type LaunchpadToken } from "@/lib/launchpad";
import { fetchTokensOn } from "@/lib/launchpadChain";
import { CHAINS, getChain, type ChainKey, type LaunchChain } from "@/lib/chains";
import { chainDownFor, loadSnapshot, markChainStatus, saveSnapshot } from "@/lib/listSnapshot";
import { chainPublicClient } from "@/lib/chainRpc";
import { cached } from "@/lib/kvCache";
import { indexedTokens } from "@/lib/indexed";

/**
 * Server-side token lists with outage resilience: a good chain read is
 * snapshotted, and if a chain is unreachable we serve its last known list so the
 * launchpad never looks empty just because an RPC is down.
 */

/** A launch, tagged with the chain it lives on. */
export type ChainToken = LaunchpadToken & { readonly chainKey: ChainKey };

export interface ChainResult {
  readonly chain: LaunchChain;
  readonly tokens: readonly ChainToken[];
  /** Served from snapshot because the chain could not be reached. */
  readonly stale: boolean;
  readonly unreachable: boolean;
}

/**
 * How long a chain stays "known down" after a failed read. While a chain is in
 * this state we skip the live read entirely and serve its snapshot, so one dead
 * RPC cannot add its full timeout to every single page render. After the window
 * expires exactly one request pays the probe cost; if the chain is back,
 * everything resumes automatically.
 *
 * This is why it exists: with Arc's RPC gated, /tokens and /portfolio were
 * taking 9.3s because every request waited out the timeout, while the same page
 * filtered to a healthy chain rendered in 0.3s.
 */
const DOWN_MEMO_MS = 60_000;
/** How long a good launch list stays fresh. Launches are infrequent, and the
 *  per-token live figures on a token page are read separately anyway. */
const LIST_CACHE_MS = 30_000;
const downSince = new Map<ChainKey, number>();

function knownDown(key: ChainKey): boolean {
  const at = downSince.get(key);
  if (at === undefined) return false;
  if (Date.now() - at < DOWN_MEMO_MS) return true;
  downSince.delete(key); // window expired — let one request re-probe
  return false;
}

/** As knownDown, but also consults the shared record so a cold serverless
 *  instance does not re-probe a chain another instance just found gated. */
async function knownDownShared(key: ChainKey): Promise<boolean> {
  if (knownDown(key)) return true;
  const downFor = await chainDownFor(key).catch(() => null);
  if (downFor === null || downFor >= DOWN_MEMO_MS) return false;
  downSince.set(key, Date.now() - downFor); // adopt it locally too
  return true;
}

/** Record the outcome for other instances; never blocks the response. */
function record(key: ChainKey, down: boolean): void {
  if (down) downSince.set(key, Date.now());
  else downSince.delete(key);
  void markChainStatus(key, down);
}

/**
 * Read budget for a full launch scan.
 *
 * This was 3s, chosen when Arc was gated and the only goal was to fail fast.
 * Once Arc came back that number quietly broke the product: enumerating the
 * four factory generations alone measured ~3.0s, so the scan lost its own race
 * on every request and the pad rendered empty against a perfectly healthy
 * chain. A dead chain is now cheap because of the circuit breaker below, not
 * because of a tight timeout, so this can afford to be generous.
 */
const READ_TIMEOUT_MS = 12_000;

/** Quick liveness probe, used to tell "slow" apart from "gone". */
const PROBE_TIMEOUT_MS = 2_500;

async function snapshotOnly(
  key: ChainKey,
): Promise<{ tokens: LaunchpadToken[]; stale: boolean; unreachable: boolean }> {
  const snap = await loadSnapshot(key).catch(() => null);
  if (snap !== null && snap.tokens.length > 0) {
    return { tokens: snap.tokens, stale: true, unreachable: true };
  }
  return { tokens: [], stale: false, unreachable: true };
}

/** Indexer first, chain second, snapshot last. */
export async function getTokens(
  timeoutMs = READ_TIMEOUT_MS,
): Promise<{ tokens: LaunchpadToken[]; stale: boolean; unreachable: boolean }> {
  // The indexer, when it is live and caught up, is the whole point: one indexed
  // query instead of a factory enumeration plus a multicall per token against an
  // RPC that charges ~420ms for any request at all. It returns null the moment
  // it is stale, still backfilling, or absent, and everything below still works.
  // No snapshot write here: the snapshot exists so an RPC outage cannot empty
  // the pad, and the database it would be written to is the same one the list
  // just came from. Writing it would add a round trip to every page load to
  // back up data against its own loss.
  const indexed = await indexedTokens().catch(() => null);
  if (indexed !== null && indexed.length > 0) {
    return { tokens: indexed, stale: false, unreachable: false };
  }

  if (await knownDownShared("arc")) return snapshotOnly("arc");

  // Cached across instances: the scan reads four factory generations and every
  // launch on them, which is the single most expensive thing the page does. On
  // serverless an in-process memo almost never gets a second hit.
  const live = await cached("arc:tokenlist", LIST_CACHE_MS, async () =>
    Promise.race([
      fetchAllTokens(arcPublicClient()).catch(() => [] as LaunchpadToken[]),
      new Promise<LaunchpadToken[]>((r) => setTimeout(() => r([]), timeoutMs)),
    ]),
  );
  if (live.length > 0) {
    record("arc", false);
    void saveSnapshot(live, "arc");
    return { tokens: live, stale: false, unreachable: false };
  }
  // Nothing came back — but that is not the same as the chain being gone. Probe
  // before condemning it, otherwise one slow scan trips the breaker and pins
  // the pad to an empty snapshot for a full minute.
  const reachable = await isReachable(getChain("arc"));
  record("arc", !reachable);
  if (reachable) return { tokens: [], stale: false, unreachable: false };
  return snapshotOnly("arc");
}

/** Can we reach this chain at all? Cheap single call, short budget. */
async function isReachable(chain: LaunchChain): Promise<boolean> {
  try {
    return await Promise.race([
      chainPublicClient(chain).getBlockNumber().then(() => true).catch(() => false),
      new Promise<boolean>((r) => setTimeout(() => r(false), PROBE_TIMEOUT_MS)),
    ]);
  } catch {
    return false;
  }
}

function tag(tokens: readonly LaunchpadToken[], chainKey: ChainKey): ChainToken[] {
  return tokens.map((t) => ({ ...t, chainKey }));
}

/** One chain's launches, with the same snapshot fallback Arc gets. */
export async function getChainTokens(
  chain: LaunchChain,
  timeoutMs = READ_TIMEOUT_MS,
): Promise<ChainResult> {
  if (chain.key === "arc") {
    const { tokens, stale, unreachable } = await getTokens(timeoutMs);
    return { chain, tokens: tag(tokens, "arc"), stale, unreachable };
  }
  if (chain.factories.length === 0) {
    return { chain, tokens: [], stale: false, unreachable: false };
  }
  if (await knownDownShared(chain.key)) {
    const snap = await snapshotOnly(chain.key);
    return { chain, tokens: tag(snap.tokens, chain.key), stale: snap.stale, unreachable: true };
  }

  const live = await Promise.race([
    fetchTokensOn(chain).catch(() => null),
    new Promise<null>((r) => setTimeout(() => r(null), timeoutMs)),
  ]);

  if (live !== null && live.tokens.length > 0) {
    record(chain.key, false);
    void saveSnapshot(live.tokens, chain.key);
    return { chain, tokens: tag(live.tokens, chain.key), stale: false, unreachable: false };
  }
  // Reached the chain and it genuinely has no launches yet — not an outage.
  if (live !== null && !live.unreachable) {
    record(chain.key, false);
    return { chain, tokens: [], stale: false, unreachable: false };
  }

  const reachable = await isReachable(chain);
  record(chain.key, !reachable);
  if (reachable) return { chain, tokens: [], stale: false, unreachable: false };
  const snap = await snapshotOnly(chain.key);
  return { chain, tokens: tag(snap.tokens, chain.key), stale: snap.stale, unreachable: true };
}

/**
 * Every launch across every configured chain, read in parallel. One chain being
 * down never blocks or empties the others — each carries its own status so the
 * UI can grey out exactly the chain that is unreachable.
 */
export async function getAllChainTokens(timeoutMs = READ_TIMEOUT_MS): Promise<ChainResult[]> {
  const targets = CHAINS.filter((c) => c.factories.length > 0);
  return Promise.all(targets.map((c) => getChainTokens(c, timeoutMs)));
}

/** Flattened, newest-chain-order list plus per-chain status. */
export async function getTokensForFilter(
  filter: ChainKey | "all",
  timeoutMs = READ_TIMEOUT_MS,
): Promise<{ tokens: ChainToken[]; results: ChainResult[] }> {
  if (filter === "all") {
    const results = await getAllChainTokens(timeoutMs);
    return { tokens: results.flatMap((r) => [...r.tokens]), results };
  }
  const result = await getChainTokens(getChain(filter), timeoutMs);
  return { tokens: [...result.tokens], results: [result] };
}
