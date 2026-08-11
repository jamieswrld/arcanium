import "server-only";
import { arcPublicClient, fetchAllTokens, type LaunchpadToken } from "@/lib/launchpad";
import { fetchTokensOn } from "@/lib/launchpadChain";
import { CHAINS, getChain, type ChainKey, type LaunchChain } from "@/lib/chains";
import { chainDownFor, loadSnapshot, markChainStatus, saveSnapshot } from "@/lib/listSnapshot";

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

/** Default read budget. Deliberately short: a healthy chain answers in well
 *  under a second, and a slow one must not hold up the page. */
const READ_TIMEOUT_MS = 3_000;

async function snapshotOnly(
  key: ChainKey,
): Promise<{ tokens: LaunchpadToken[]; stale: boolean; unreachable: boolean }> {
  const snap = await loadSnapshot(key).catch(() => null);
  if (snap !== null && snap.tokens.length > 0) {
    return { tokens: snap.tokens, stale: true, unreachable: true };
  }
  return { tokens: [], stale: false, unreachable: true };
}

/** Arc keeps its original, battle-tested read path. */
export async function getTokens(
  timeoutMs = READ_TIMEOUT_MS,
): Promise<{ tokens: LaunchpadToken[]; stale: boolean; unreachable: boolean }> {
  if (await knownDownShared("arc")) return snapshotOnly("arc");

  const live = await Promise.race([
    fetchAllTokens(arcPublicClient()).catch(() => [] as LaunchpadToken[]),
    new Promise<LaunchpadToken[]>((r) => setTimeout(() => r([]), timeoutMs)),
  ]);
  if (live.length > 0) {
    record("arc", false);
    void saveSnapshot(live, "arc");
    return { tokens: live, stale: false, unreachable: false };
  }
  record("arc", true);
  return snapshotOnly("arc");
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

  record(chain.key, true);
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
