import { fallback, http, type Transport } from "viem";

/**
 * Arc RPC endpoints, in preference order. A single provider going down (or
 * starting to require auth, as Blockdaemon did) must never take the site
 * offline, so every read path runs through a ranked fallback list.
 *
 * Configure with a comma-separated list — server: ARC_RPC_URLS, browser:
 * NEXT_PUBLIC_ARC_RPC_URLS. Anything configured is tried before the defaults.
 */

const DEFAULTS: readonly string[] = [
  // Blockdaemon is the preferred primary. It began requiring an API key, so
  // set ARC_BLOCKDAEMON_KEY (or put the full authed URL in ARC_RPC_URLS) and
  // it is used ahead of everything else automatically.
  "https://rpc.blockdaemon.mainnet.arc.io",
  "https://5042.rpc.thirdweb.com/8b0c89cd3b125e7f8f744f5e56f6436a",
  "https://5042.rpc.thirdweb.com",
];

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
