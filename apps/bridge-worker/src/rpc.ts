import { fallback, http, type Transport } from "viem";

/**
 * Resilient RPC helpers shared by the bridge workers.
 *
 * Public Arc RPCs rate-limit aggressively (HTTP 429), and a single hung
 * request previously wedged a worker loop forever with no log output. Every
 * network call now goes through bounded timeouts, capped retries, and — where
 * more than one endpoint is configured — provider fallback.
 *
 * Set ARC_RPC_URLS / BASE_RPC_URLS to a comma-separated list to add a
 * dedicated (keyed) endpoint; the first entry is preferred, the rest are
 * failovers.
 */

export function transportFor(primary: string, listEnv: string | undefined): Transport {
  const urls = (listEnv ?? "")
    .split(",")
    .map((u) => u.trim())
    .filter((u) => u.length > 0);
  const all = urls.length > 0 ? urls : [primary];
  const transports = all.map((u) => http(u, { timeout: 15_000, retryCount: 2, retryDelay: 1_000 }));
  return transports.length === 1 ? (transports[0] as Transport) : fallback(transports, { rank: false });
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run an async RPC operation with exponential backoff. Never retries a real
 * contract revert — only transient transport failures (429s, timeouts).
 */
export async function withRetry<T>(fn: () => Promise<T>, attempts = 5): Promise<T> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const message = err instanceof Error ? err.message : String(err);
      if (/revert|AlreadyProcessed|execution reverted/i.test(message)) throw err;
      await sleep(Math.min(2_000 * 2 ** i, 20_000));
    }
  }
  throw lastError;
}
