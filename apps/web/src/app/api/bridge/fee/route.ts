import { NextResponse } from "next/server";

/**
 * Circle fast-transfer fee lookup (proxied for CORS). Returns the minimum fee
 * Circle charges for the fast lane on a route, so the widget can set a maxFee
 * that actually engages fast finality instead of silently falling back to
 * hard finality (~15–20 min).
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  const url = new URL(request.url);
  const src = url.searchParams.get("src");
  const dst = url.searchParams.get("dst");
  if (src === null || !/^\d{1,3}$/.test(src) || dst === null || !/^\d{1,3}$/.test(dst)) {
    return NextResponse.json({ error: "src and dst required" }, { status: 400 });
  }
  try {
    const res = await fetch(`https://iris-api.circle.com/v2/burn/USDC/fees/${src}/${dst}`, {
      headers: { accept: "application/json" },
      next: { revalidate: 60 },
    });
    const rows = (await res.json()) as Array<{ finalityThreshold?: number; minimumFee?: number }>;
    const fast = rows.find((r) => r.finalityThreshold === 1000);
    const standard = rows.find((r) => r.finalityThreshold === 2000);
    return NextResponse.json({
      fastMinimumFee: fast?.minimumFee ?? null,
      standardMinimumFee: standard?.minimumFee ?? null,
    });
  } catch {
    return NextResponse.json({ fastMinimumFee: null, standardMinimumFee: null });
  }
}
