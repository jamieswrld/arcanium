import { NextResponse } from "next/server";
import { indexerHealth } from "@/lib/indexed";

/**
 * Is the indexer alive and caught up?
 *
 * The site works either way — every read path falls back to the chain — which
 * is exactly why this endpoint is needed: a dead indexer is invisible from the
 * outside apart from pages quietly getting slow again. Point an uptime check at
 * this and the failure becomes loud.
 *
 * 200 when caught up, 503 otherwise, so a plain HTTP monitor needs no parsing.
 */

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  const health = await indexerHealth().catch(() => null);

  if (health === null) {
    return NextResponse.json(
      { ok: false, reason: "no indexer_health row — the indexer has never run against this database" },
      { status: 503 },
    );
  }

  const body = {
    ok: health.caughtUp,
    tip: health.tip.toString(),
    behind: health.behind.toString(),
    ageSeconds: Math.round(health.ageMs / 1000),
    reason: health.caughtUp
      ? null
      : health.ageMs >= 120_000
        ? "stale: no write in the last two minutes"
        : "behind: still backfilling",
  };
  return NextResponse.json(body, { status: health.caughtUp ? 200 : 503 });
}
