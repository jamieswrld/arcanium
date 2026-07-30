import { NextResponse } from "next/server";

/**
 * Same-origin Arc JSON-RPC proxy. The browser talks to this route (never
 * cross-origin), and we forward to the Arc RPC server-side — where reads are
 * proven reliable. This eliminates client-side RPC failure modes (CORS quirks,
 * provider rate-limits, batching edge cases) that otherwise leave balances and
 * contract reads blank in the UI. Read-only by design: wallets still send
 * transactions through their own provider, not this proxy.
 */

const UPSTREAM =
  process.env["ARC_RPC_SERVER_URL"] ??
  process.env["NEXT_PUBLIC_ARC_RPC_URL"] ??
  "https://rpc.blockdaemon.mainnet.arc.io";

export async function POST(request: Request): Promise<NextResponse> {
  const body = await request.text();
  try {
    const res = await fetch(UPSTREAM, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      // Never cache RPC results.
      cache: "no-store",
    });
    const text = await res.text();
    return new NextResponse(text, {
      status: res.status,
      headers: { "content-type": "application/json" },
    });
  } catch {
    return NextResponse.json(
      { jsonrpc: "2.0", id: null, error: { code: -32603, message: "upstream RPC unavailable" } },
      { status: 502 },
    );
  }
}
