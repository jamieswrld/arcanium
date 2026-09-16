import { NextResponse } from "next/server";
import { authorizeUrl, newPkce, xPayoutsConfigured } from "@/lib/xIdentity";

/**
 * GET /api/x/auth/start?return=/locked
 *
 * Begins the OAuth round trip. The PKCE verifier and CSRF state are written to
 * httpOnly cookies, so the browser carries them but no script can read them and
 * nothing that comes back through the redirect can substitute them.
 */
export const dynamic = "force-dynamic";

const COOKIE_TTL = 10 * 60;

export async function GET(request: Request): Promise<Response> {
  if (!xPayoutsConfigured()) {
    return NextResponse.json({ error: "X payouts are not configured." }, { status: 503 });
  }
  const url = new URL(request.url);
  const redirectUri = `${url.origin}/api/x/auth/callback`;
  const { verifier, challenge, state } = newPkce();

  const authorize = authorizeUrl(challenge, state, redirectUri);
  if (authorize === null) {
    return NextResponse.json({ error: "X payouts are not configured." }, { status: 503 });
  }

  // Only same-origin relative paths, so the callback cannot be used as an open
  // redirect onto someone else's site.
  const raw = url.searchParams.get("return") ?? "/create";
  const returnTo = raw.startsWith("/") && !raw.startsWith("//") ? raw : "/create";

  const res = NextResponse.redirect(authorize);
  const opts = { httpOnly: true, secure: true, sameSite: "lax" as const, path: "/", maxAge: COOKIE_TTL };
  res.cookies.set("x_pkce", verifier, opts);
  res.cookies.set("x_state", state, opts);
  res.cookies.set("x_return", returnTo, opts);
  return res;
}
