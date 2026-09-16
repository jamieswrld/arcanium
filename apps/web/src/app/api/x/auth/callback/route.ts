import { NextResponse } from "next/server";
import { exchangeCode, mintSession, xPayoutsConfigured } from "@/lib/xIdentity";

/**
 * GET /api/x/auth/callback
 *
 * Completes the round trip and mints a short-lived session proving this browser
 * controls a specific X account. The session carries the numeric id only — the
 * handle is along for display and is never what anything is keyed on.
 */
export const dynamic = "force-dynamic";

function fail(origin: string, reason: string): NextResponse {
  // Back to the app with an error in the URL rather than a bare JSON page: the
  // user is mid-flow in a browser, not calling an API.
  const res = NextResponse.redirect(`${origin}/create?x_error=${encodeURIComponent(reason)}`);
  for (const c of ["x_pkce", "x_state", "x_return"]) res.cookies.delete(c);
  return res;
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const origin = url.origin;
  if (!xPayoutsConfigured()) return fail(origin, "not_configured");

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

  const verifier = read("x_pkce");
  const expectedState = read("x_state");
  const returnTo = read("x_return") ?? "/create";

  // CSRF: the state must be the one this browser was issued. Without it, an
  // attacker could complete a flow in a victim's session and bind their wallet
  // to an account they control.
  if (verifier === undefined || expectedState === undefined || state !== expectedState) {
    return fail(origin, "bad_state");
  }

  const profile = await exchangeCode(code, verifier, `${origin}/api/x/auth/callback`);
  if (profile === null) return fail(origin, "exchange_failed");

  const session = mintSession(profile);
  if (session === null) return fail(origin, "not_configured");

  const res = NextResponse.redirect(
    `${origin}${returnTo}${returnTo.includes("?") ? "&" : "?"}x_verified=${encodeURIComponent(profile.username)}`,
  );
  for (const c of ["x_pkce", "x_state", "x_return"]) res.cookies.delete(c);
  res.cookies.set("x_session", session, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: 15 * 60,
  });
  return res;
}
