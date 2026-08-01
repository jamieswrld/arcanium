import "server-only";
import { arcPublicClient, fetchAllTokens, type LaunchpadToken } from "@/lib/launchpad";
import { loadSnapshot, saveSnapshot } from "@/lib/listSnapshot";

/**
 * Server-side token list with outage resilience: a good chain read is snapshotted,
 * and if the chain is unreachable we serve the last known list so the launchpad
 * never looks empty just because an RPC is down.
 */
export async function getTokens(timeoutMs = 9000): Promise<{ tokens: LaunchpadToken[]; stale: boolean }> {
  const live = await Promise.race([
    fetchAllTokens(arcPublicClient()).catch(() => [] as LaunchpadToken[]),
    new Promise<LaunchpadToken[]>((r) => setTimeout(() => r([]), timeoutMs)),
  ]);
  if (live.length > 0) {
    void saveSnapshot(live);
    return { tokens: live, stale: false };
  }
  const snap = await loadSnapshot().catch(() => null);
  if (snap !== null && snap.tokens.length > 0) return { tokens: snap.tokens, stale: true };
  return { tokens: [], stale: false };
}
