import { NextResponse } from "next/server";

/** Current deployment id — lets the client detect a newer build and prompt a
 *  refresh instead of letting users act on stale contract addresses. */
export const dynamic = "force-dynamic";

export function GET(): NextResponse {
  return NextResponse.json({
    version:
      process.env["VERCEL_DEPLOYMENT_ID"] ??
      process.env["VERCEL_GIT_COMMIT_SHA"] ??
      "dev",
  });
}
