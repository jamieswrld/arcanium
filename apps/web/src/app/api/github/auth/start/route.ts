import { NextResponse } from "next/server";
import { githubAuthorizeUrl, githubConfigured, newState } from "@/lib/githubIdentity";

/**
 * GET /api/github/auth/start?return=/portfolio
 *
 * Begins GitHub's OAuth round trip.
 *
 * No PKCE here, unlike the X flow, and that is GitHub's design rather than an
 * omission: their OAuth app is a confidential client with a secret, so `state`
 * carries the CSRF protection alone. It still goes in an httpOnly cookie, so
 * the browser returns it but no script can read or substitute it.
 */
export const dynamic = "force-dynamic";

const COOKIE_TTL = 10 * 60;

export async function GET(request: Request): Promise<Response> {
  if (!githubConfigured()) {
    return NextResponse.json({ error: "GitHub payouts are not configured." }, { status: 503 });
  }
  const url = new URL(request.url);
  const redirectUri = `${url.origin}/api/github/auth/callback`;
  const state = newState();

  const authorize = githubAuthorizeUrl(state, redirectUri);
  if (authorize === null) {
    return NextResponse.json({ error: "GitHub payouts are not configured." }, { status: 503 });
  }

  // Same-origin relative paths only, so the callback cannot be turned into an
  // open redirect onto somebody else's site.
  const raw = url.searchParams.get("return") ?? "/create";
  const returnTo = raw.startsWith("/") && !raw.startsWith("//") ? raw : "/create";

  const res = NextResponse.redirect(authorize);
  const opts = { httpOnly: true, secure: true, sameSite: "lax" as const, path: "/", maxAge: COOKIE_TTL };
  res.cookies.set("gh_state", state, opts);
  res.cookies.set("gh_return", returnTo, opts);
  return res;
}
