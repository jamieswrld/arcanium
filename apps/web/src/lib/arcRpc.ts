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
  "https://rpc.blockdaemon.mainnet.arc.io",
  "https://5042.rpc.thirdweb.com/8b0c89cd3b125e7f8f744f5e56f6436a",
  "https://5042.rpc.thirdweb.com",
];

function parse(list: string | undefined): string[] {
  if (list === undefined || list.trim() === "") return [];
  return list.split(",").map((s) => s.trim()).filter((s) => /^https?:\/\//.test(s));
}

/** Server-side endpoint list (never exposed to the browser unless public). */
export function arcRpcUrls(): string[] {
  const configured = [
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
        ...parse(process.env["NEXT_PUBLIC_ARC_RPC_URLS"]),
        ...parse(process.env["NEXT_PUBLIC_ARC_RPC_URL"]),
        ...DEFAULTS,
      ]
    : arcRpcUrls();
  const seen = new Set<string>();
  const unique = urls.filter((u) => (seen.has(u) ? false : (seen.add(u), true)));
  return fallback(
    unique.map((url) => http(url, { timeout: 12_000, retryCount: 1 })),
    { rank: { interval: 60_000, sampleCount: 3 } },
  );
}
