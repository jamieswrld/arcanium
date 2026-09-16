import { NextResponse } from "next/server";
import { arcRpcUrls } from "@/lib/arcRpc";

/**
 * Same-origin Arc JSON-RPC proxy with automatic failover. The browser talks to
 * this one stable endpoint; we try each upstream in order until one answers, so
 * a provider going down (or starting to demand auth) never reaches the user.
 * Read-only by design: wallets still send transactions through their own
 * provider, not this proxy.
 */
export const dynamic = "force-dynamic";

/**
 * Codes that mean "this endpoint could not serve the request", so the next one
 * is worth trying. Everything else is an answer, even an unwelcome one.
 *
 * This list is deliberately an allowlist of failures rather than an allowlist
 * of answers. The previous rule kept only -32000..-32099 as real answers, and
 * Arc reports a reverted call as code 3 — the standard revert code, carrying
 * the reason in `data`. So every ordinary revert looked like a broken provider:
 * the proxy swept all five upstreams, got the same revert from each, threw the
 * reason away and told the user "All Arc RPC endpoints are unavailable". A
 * failed gas estimate is the normal way a contract says no, and it was being
 * reported as an outage — while costing five upstream requests each time, which
 * fed the rate limiting that then caused real failures.
 */
const ENDPOINT_FAILURE_CODES = new Set([
  -32005, // rate limited / out of capacity (arc-scan, QuickNode)
  -32014, // QuickNode: requested data not available (pruned range)
  -32603, // internal error
  -32601, // method not found — another provider may well implement it
  -32006, // JSON-RPC version unsupported: a quarrel with that provider, not an
  //         answer. Showing it to a user as "Version of JSON-RPC protocol is
  //         not supported" explains nothing they can act on.
  4444, // arc-scan: pruned history unavailable
]);

/** Whether an upstream response should be returned, or the next one tried. */
function isUsable(text: string): boolean {
  if (text.trimStart().startsWith("<")) return false; // HTML error page
  try {
    const body = JSON.parse(text) as { error?: { code?: number } } | Array<{ error?: unknown }>;
    if (Array.isArray(body)) return true; // batch: let the client sort it out
    if (body.error === undefined) return true;
    const code = body.error.code;
    return code === undefined || !ENDPOINT_FAILURE_CODES.has(code);
  } catch {
    return false;
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  const body = await request.text();
  const urls = arcRpcUrls();
  let lastText: string | null = null;

  for (const url of urls) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        cache: "no-store",
        signal: AbortSignal.timeout(12_000),
      });
      const text = await res.text();
      if (res.ok && isUsable(text)) {
        return new NextResponse(text, { status: 200, headers: { "content-type": "application/json" } });
      }
      lastText = text;
    } catch {
      // try the next endpoint
    }
  }

  return NextResponse.json(
    {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32603, message: "All Arc RPC endpoints are unavailable", data: lastText?.slice(0, 200) },
    },
    { status: 502 },
  );
}
