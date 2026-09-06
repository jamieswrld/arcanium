import { defineChain, fallback, http, type Chain, type Transport } from "viem";
import { getChain } from "@/lib/chains";

/**
 * Arc RPC endpoints, in preference order. A single provider going down (or
 * starting to require auth, as Blockdaemon did) must never take the site
 * offline, so every read path runs through a ranked fallback list.
 *
 * Configure with a comma-separated list — server: ARC_RPC_URLS, browser:
 * NEXT_PUBLIC_ARC_RPC_URLS. Anything configured is tried before the defaults.
 */

/**
 * Arc's endpoints come from the chain registry — one source of truth.
 *
 * These used to be a second hardcoded list, and it bit exactly as you would
 * expect: a working RPC was added to chains.ts, every chain-registry read
 * recovered, and this path kept dialling the dead endpoints, so the launchpad
 * still rendered empty. Do not reintroduce a local copy.
 */
const DEFAULTS: readonly string[] = getChain("arc").rpcUrls;

/** Blockdaemon with the operator's key, when configured. */
function blockdaemonAuthed(): string[] {
  const key = process.env["ARC_BLOCKDAEMON_KEY"] ?? process.env["NEXT_PUBLIC_ARC_BLOCKDAEMON_KEY"];
  if (key === undefined || key.trim() === "") return [];
  return [`https://svc.blockdaemon.com/arc/mainnet/native?apiKey=${key.trim()}`];
}

function parse(list: string | undefined): string[] {
  if (list === undefined || list.trim() === "") return [];
  return list.split(",").map((s) => s.trim()).filter((s) => /^https?:\/\//.test(s));
}

/** Server-side endpoint list (never exposed to the browser unless public). */
export function arcRpcUrls(): string[] {
  const configured = [
    ...blockdaemonAuthed(),
    ...parse(process.env["ARC_RPC_URLS"]),
    ...parse(process.env["NEXT_PUBLIC_ARC_RPC_URLS"]),
    ...parse(process.env["ARC_RPC_SERVER_URL"]),
    ...parse(process.env["NEXT_PUBLIC_ARC_RPC_URL"]),
  ];
  const seen = new Set<string>();
  return [...configured, ...DEFAULTS].filter((u) => (seen.has(u) ? false : (seen.add(u), true)));
}

/**
 * Ranked fallback transport: viem probes endpoints and prefers whichever is
 * healthiest, automatically routing around one that starts failing.
 */
export function arcTransport(opts?: { readonly browser?: boolean }): Transport {
  const urls = opts?.browser === true
    ? [
        // Same-origin proxy first in the browser: it hides upstream churn and
        // survives providers that block cross-origin calls.
        "/api/arc-rpc",
        ...blockdaemonAuthed(),
        ...parse(process.env["NEXT_PUBLIC_ARC_RPC_URLS"]),
        ...parse(process.env["NEXT_PUBLIC_ARC_RPC_URL"]),
        ...DEFAULTS,
      ]
    : arcRpcUrls();
  const seen = new Set<string>();
  const unique = urls.filter((u) => (seen.has(u) ? false : (seen.add(u), true)));
  // Short per-endpoint budget with no retry. A healthy node answers in well
  // under a second; a dead one must fail fast so the fallback list is exhausted
  // quickly and the caller can serve its snapshot. With 12s + a retry per
  // endpoint, a gated chain took long enough to stall page renders.
  return fallback(
    unique.map((url) => http(url, { timeout: 2_500, retryCount: 0 })),
    { rank: { interval: 60_000, sampleCount: 3 } },
  );
}

/**
 * Arc, as viem understands it.
 *
 * The important part is `contracts.multicall3`: Multicall3 is deployed on Arc
 * at the canonical address, so viem can fold a whole page of reads into one
 * request. That matters here because the public RPC rate-limits bursts — firing
 * ~100 individual reads to list the pad returned only a fraction of them, and
 * the missing ones were silently swallowed as "no token". One multicall per
 * batch fixes both the losses and the latency.
 */
export const arcChain: Chain = defineChain({
  id: 5042,
  name: "Arc",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [...DEFAULTS] } },
  blockExplorers: { default: { name: "Blockscout", url: "https://arc-mainnet.cloud.blockscout.com" } },
  contracts: {
    multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" },
  },
});
