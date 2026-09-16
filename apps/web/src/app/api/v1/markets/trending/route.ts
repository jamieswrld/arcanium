import type { NextResponse } from "next/server";
import { GET as markets, OPTIONS as opts } from "../route";

/**
 * GET /api/v1/markets/trending
 *
 * A named alias for /api/v1/markets?sort=trending, so integrations can hold a
 * stable URL rather than a query string this API might later redefine.
 */
export const dynamic = "force-dynamic";
export const OPTIONS = opts;

export async function GET(request: Request): Promise<NextResponse> {
  const url = new URL(request.url);
  url.searchParams.set("sort", "trending");
  return markets(new Request(url, request));
}
