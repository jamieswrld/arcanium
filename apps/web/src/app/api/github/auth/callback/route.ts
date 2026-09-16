import { NextResponse } from "next/server";
import { exchangeGithubCode, githubConfigured, mintSocialSession } from "@/lib/githubIdentity";

/**
 * GET /api/github/auth/callback
 *
 * Completes GitHub's round trip and mints a short-lived session proving this
 * browser controls a specific GitHub account.
 *
 * The session records the platform alongside the account. Without that, a
 * session earned by signing in to GitHub could be presented to the X endpoints
 * and used to claim the X vault of the same name — the collision the
 * namespaced vault key closes, reintroduced one layer up.
 */
export const dynamic = "force-dynamic";

function fail(origin: string, reason: string): NextResponse {
  // Back into the app with the reason in the URL: the person is mid-flow in a
  // browser, not calling an API, and a bare JSON error is a dead end for them.
  const res = NextResponse.redirect(`${origin}/create?gh_error=${encodeURIComponent(reason)}`);
  for (const c of ["gh_state", "gh_return"]) res.cookies.delete(c);
  return res;
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const origin = url.origin;
  if (!githubConfigured()) return fail(origin, "not_configured");

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (url.searchParams.get("error") !== null) return fail(origin, "denied");
  if (code === null || state === null) return fail(origin, "missing_code");

  const jar = request.headers.get("cookie") ?? "";
  const read = (name: string): string | undefined =>
    jar
      .split(";")
      .map((c) => c.trim())
      .find((c) => c.startsWith(`${name}=`))
      ?.slice(name.length + 1);

  const expectedState = read("gh_state");
  const returnTo = read("gh_return") ?? "/create";

  // CSRF: the state must be the one this browser was issued. Without it an
  // attacker could finish a flow inside a victim's session and bind their
  // wallet to an account the attacker controls.
  if (expectedState === undefined || state !== expectedState) return fail(origin, "bad_state");

  const profile = await exchangeGithubCode(code, `${origin}/api/github/auth/callback`);
  if (profile === null) return fail(origin, "exchange_failed");

  const session = mintSocialSession("github", profile.id, profile.username);
  if (session === null) return fail(origin, "not_configured");

  const res = NextResponse.redirect(
    `${origin}${returnTo}${returnTo.includes("?") ? "&" : "?"}gh_verified=${encodeURIComponent(profile.username)}`,
  );
  for (const c of ["gh_state", "gh_return"]) res.cookies.delete(c);
  res.cookies.set("gh_session", session, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: 15 * 60,
  });
  return res;
}
