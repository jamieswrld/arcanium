import type { NextResponse } from "next/server";
import { GET as markets, OPTIONS as opts } from "../route";

/** GET /api/v1/markets/new — newest launches first. Alias of ?sort=new. */
export const dynamic = "force-dynamic";
export const OPTIONS = opts;

export async function GET(request: Request): Promise<NextResponse> {
  const url = new URL(request.url);
  url.searchParams.set("sort", "new");
  return markets(new Request(url, request));
}
