import "server-only";
import { arcPublicClient, fetchAllTokens, type LaunchpadToken } from "@/lib/launchpad";
import { fetchTokensOn } from "@/lib/launchpadChain";
import { CHAINS, getChain, type ChainKey, type LaunchChain } from "@/lib/chains";
import { loadSnapshot, saveSnapshot } from "@/lib/listSnapshot";

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

/** Arc keeps its original, battle-tested read path. */
export async function getTokens(
  timeoutMs = 9000,
): Promise<{ tokens: LaunchpadToken[]; stale: boolean; unreachable: boolean }> {
  const live = await Promise.race([
    fetchAllTokens(arcPublicClient()).catch(() => [] as LaunchpadToken[]),
    new Promise<LaunchpadToken[]>((r) => setTimeout(() => r([]), timeoutMs)),
  ]);
  if (live.length > 0) {
    void saveSnapshot(live, "arc");
    return { tokens: live, stale: false, unreachable: false };
  }
  const snap = await loadSnapshot("arc").catch(() => null);
  if (snap !== null && snap.tokens.length > 0) {
    return { tokens: snap.tokens, stale: true, unreachable: true };
  }
  return { tokens: [], stale: false, unreachable: true };
}

function tag(tokens: readonly LaunchpadToken[], chainKey: ChainKey): ChainToken[] {
  return tokens.map((t) => ({ ...t, chainKey }));
}

/** One chain's launches, with the same snapshot fallback Arc gets. */
export async function getChainTokens(chain: LaunchChain, timeoutMs = 9000): Promise<ChainResult> {
  if (chain.key === "arc") {
    const { tokens, stale, unreachable } = await getTokens(timeoutMs);
    return { chain, tokens: tag(tokens, "arc"), stale, unreachable };
  }
  if (chain.factories.length === 0) {
    return { chain, tokens: [], stale: false, unreachable: false };
  }

  const live = await Promise.race([
    fetchTokensOn(chain).catch(() => null),
    new Promise<null>((r) => setTimeout(() => r(null), timeoutMs)),
  ]);

  if (live !== null && live.tokens.length > 0) {
    void saveSnapshot(live.tokens, chain.key);
    return { chain, tokens: tag(live.tokens, chain.key), stale: false, unreachable: false };
  }
  // Reached the chain and it genuinely has no launches yet — not an outage.
  if (live !== null && !live.unreachable) {
    return { chain, tokens: [], stale: false, unreachable: false };
  }

  const snap = await loadSnapshot(chain.key).catch(() => null);
  if (snap !== null && snap.tokens.length > 0) {
    return { chain, tokens: tag(snap.tokens, chain.key), stale: true, unreachable: true };
  }
  return { chain, tokens: [], stale: false, unreachable: true };
}

/**
 * Every launch across every configured chain, read in parallel. One chain being
 * down never blocks or empties the others — each carries its own status so the
 * UI can grey out exactly the chain that is unreachable.
 */
export async function getAllChainTokens(timeoutMs = 9000): Promise<ChainResult[]> {
  const targets = CHAINS.filter((c) => c.factories.length > 0);
  return Promise.all(targets.map((c) => getChainTokens(c, timeoutMs)));
}

/** Flattened, newest-chain-order list plus per-chain status. */
export async function getTokensForFilter(
  filter: ChainKey | "all",
  timeoutMs = 9000,
): Promise<{ tokens: ChainToken[]; results: ChainResult[] }> {
  if (filter === "all") {
    const results = await getAllChainTokens(timeoutMs);
    return { tokens: results.flatMap((r) => [...r.tokens]), results };
  }
  const result = await getChainTokens(getChain(filter), timeoutMs);
  return { tokens: [...result.tokens], results: [result] };
}
