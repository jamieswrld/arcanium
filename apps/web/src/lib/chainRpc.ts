import { createPublicClient, fallback, http, type PublicClient, type Transport } from "viem";
import { getChain, type ChainKey, type LaunchChain } from "@/lib/chains";

/**
 * Per-chain RPC access with ranked fallback.
 *
 * Arc taught the lesson this module exists for: a single provider that starts
 * requiring auth (Blockdaemon began returning 401) must never take the site
 * offline. Every chain therefore gets a list, viem probes them, and reads route
 * around whichever is unhealthy.
 *
 * Server-only endpoints (paid keys) go in <CHAIN>_RPC_URLS and are tried first;
 * they are never shipped to the browser. Public ones can go in
 * NEXT_PUBLIC_<CHAIN>_RPC_URLS. Static literal keys only — see chains.ts.
 */

function parse(list: string | undefined): string[] {
  if (list === undefined || list.trim() === "") return [];
  return list.split(",").map((s) => s.trim()).filter((s) => /^https?:\/\//.test(s));
}

/** Blockdaemon with the operator's key, when configured (Arc only). */
function arcBlockdaemon(): string[] {
  const key = process.env["ARC_BLOCKDAEMON_KEY"] ?? process.env["NEXT_PUBLIC_ARC_BLOCKDAEMON_KEY"];
  if (key === undefined || key.trim() === "") return [];
  return [`https://svc.blockdaemon.com/arc/mainnet/native?apiKey=${key.trim()}`];
}

/** Private, server-side-only endpoints for a chain, highest priority. */
function privateUrls(key: ChainKey): string[] {
  switch (key) {
    case "arc":
      return [
        ...arcBlockdaemon(),
        ...parse(process.env["ARC_RPC_URLS"]),
        ...parse(process.env["ARC_RPC_SERVER_URL"]),
      ];
    case "robinhood":
      return parse(process.env["ROBINHOOD_RPC_URLS"]);
    case "bnb":
      return parse(process.env["BNB_RPC_URLS"]);
  }
}

function unique(urls: readonly string[]): string[] {
  const seen = new Set<string>();
  return urls.filter((u) => (seen.has(u) ? false : (seen.add(u), true)));
}

/** Full server-side endpoint list for a chain, best first. */
export function rpcUrls(chain: LaunchChain): string[] {
  return unique([...privateUrls(chain.key), ...chain.rpcUrls]);
}

/**
 * Ranked fallback transport. In the browser a same-origin proxy goes first: it
 * hides upstream churn, keeps private keys server-side, and survives providers
 * that block cross-origin calls.
 */
export function chainTransport(chain: LaunchChain, opts?: { readonly browser?: boolean }): Transport {
  const urls =
    opts?.browser === true
      ? unique([`/api/rpc/${chain.key}`, ...chain.rpcUrls])
      : rpcUrls(chain);
  // Short per-endpoint budget with no retry. A healthy node answers in well
  // under a second; a dead one must fail fast so the fallback list is exhausted
  // quickly and the caller can serve its snapshot. With 12s + a retry per
  // endpoint, a gated chain took long enough to stall page renders.
  return fallback(
    urls.map((url) => http(url, { timeout: 2_500, retryCount: 0 })),
    { rank: { interval: 60_000, sampleCount: 3 } },
  );
}

export function chainPublicClient(chain: LaunchChain): PublicClient {
  return createPublicClient({ transport: chainTransport(chain) });
}

export function publicClientFor(key: ChainKey): PublicClient {
  return chainPublicClient(getChain(key));
}
