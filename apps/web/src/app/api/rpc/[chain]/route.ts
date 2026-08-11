import { NextResponse } from "next/server";
import { rpcUrls } from "@/lib/chainRpc";
import { CHAINS, getChain, type ChainKey } from "@/lib/chains";

/**
 * Same-origin JSON-RPC proxy, one route for every launch chain. The browser
 * talks to a single stable endpoint per chain and we try each upstream in order
 * until one answers, so a provider going down (or starting to demand auth)
 * never reaches the user — and private keys stay server-side.
 *
 * Read-only by design: wallets still send transactions through their own
 * provider, not this proxy.
 */
export const dynamic = "force-dynamic";

const VALID = new Set<string>(CHAINS.map((c) => c.key));

/** A JSON-RPC body that carries an `error` is a failed upstream for our
 *  purposes — fall through to the next provider rather than returning it. */
function isUsable(text: string): boolean {
  if (text.trimStart().startsWith("<")) return false; // HTML error page
  try {
    const body = JSON.parse(text) as { error?: { code?: number } } | Array<{ error?: unknown }>;
    if (Array.isArray(body)) return true; // batch: let the client sort it out
    if (body.error === undefined) return true;
    // -32000..-32099 are execution-level errors (a real answer); anything else
    // (auth, rate limit, internal) means try the next endpoint.
    const code = body.error.code ?? 0;
    return code <= -32000 && code >= -32099;
  } catch {
    return false;
  }
}

export async function POST(
  request: Request,
  ctx: { params: Promise<{ chain: string }> },
): Promise<NextResponse> {
  const { chain: raw } = await ctx.params;
  const key = raw.toLowerCase();
  if (!VALID.has(key)) {
    return NextResponse.json(
      { jsonrpc: "2.0", id: null, error: { code: -32602, message: `Unknown chain: ${raw}` } },
      { status: 404 },
    );
  }
  const chain = getChain(key as ChainKey);
  const body = await request.text();
  let lastText: string | null = null;

  for (const url of rpcUrls(chain)) {
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
      error: {
        code: -32603,
        message: `All ${chain.name} RPC endpoints are unavailable`,
        data: lastText?.slice(0, 200),
      },
    },
    { status: 502 },
  );
}
