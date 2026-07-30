import { NextResponse } from "next/server";

/**
 * Circle Iris attestation proxy (server-side to sidestep CORS). Given the
 * source domain and burn tx hash, returns the CCTP v2 message + attestation
 * once Circle has attested; { status: "pending" } until then.
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  const url = new URL(request.url);
  const domain = url.searchParams.get("domain");
  const tx = url.searchParams.get("tx");
  if (domain === null || !/^\d{1,3}$/.test(domain) || tx === null || !/^0x[0-9a-fA-F]{64}$/.test(tx)) {
    return NextResponse.json({ error: "domain and tx required" }, { status: 400 });
  }
  try {
    const res = await fetch(`https://iris-api.circle.com/v2/messages/${domain}?transactionHash=${tx}`, {
      headers: { accept: "application/json" },
      cache: "no-store",
    });
    if (res.status === 404) return NextResponse.json({ status: "pending" });
    const body = (await res.json()) as { messages?: Array<{ status?: string; message?: string; attestation?: string; eventNonce?: string }> };
    const msg = body.messages?.[0];
    if (msg === undefined || msg.status !== "complete" || msg.message === undefined || msg.attestation === undefined) {
      return NextResponse.json({ status: "pending" });
    }
    return NextResponse.json({ status: "complete", message: msg.message, attestation: msg.attestation });
  } catch {
    return NextResponse.json({ status: "pending" });
  }
}
