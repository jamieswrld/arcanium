import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Proving somebody controls a GitHub account.
 *
 * The same shape as the X flow and for the same reason: no chain can check who
 * owns an account off it, so a claim needs the platform itself to confirm the
 * person is who they say. What differs is the mechanics, and the differences
 * are worth naming because they are easy to get wrong by analogy:
 *
 *   · GitHub's OAuth app flow has no PKCE. It is a confidential client with a
 *     secret, and `state` carries the CSRF protection on its own.
 *   · The token response is JSON only if you ask for it; without an Accept
 *     header GitHub replies in form-encoding and the parse silently fails.
 *   · `read:user` is the whole requirement — the numeric id and the login. Not
 *     `user`, which would also hand us private email addresses we have no use
 *     for and no business holding.
 *
 * A GitHub OAuth App is free and has no paid tier, so unlike X there is no
 * lookup credential to do without.
 */

const AUTHORIZE = "https://github.com/login/oauth/authorize";
const TOKEN = "https://github.com/login/oauth/access_token";
const API = "https://api.github.com";

const SESSION_TTL_MS = 15 * 60_000;

export interface GithubProfile {
  readonly id: string;
  readonly username: string;
  readonly name: string;
  readonly avatarUrl: string | null;
}

function env(name: string): string | null {
  const v = process.env[name];
  return v === undefined || v.length === 0 ? null : v;
}

/** Whether GitHub payouts can work at all right now. */
export function githubConfigured(): boolean {
  return (
    env("GITHUB_CLIENT_ID") !== null &&
    env("GITHUB_CLIENT_SECRET") !== null &&
    env("X_ATTESTATION_SIGNER_KEY") !== null
  );
}

export function githubAuthorizeUrl(state: string, redirectUri: string): string | null {
  const clientId = env("GITHUB_CLIENT_ID");
  if (clientId === null) return null;
  const p = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    // Public profile only. `user` would include private emails, which this
    // never needs and should therefore never be able to see.
    scope: "read:user",
    state,
    allow_signup: "false",
  });
  return `${AUTHORIZE}?${p.toString()}`;
}

/**
 * Exchange the callback code for the account behind it.
 *
 * Returns null on anything unexpected rather than throwing: the caller's job
 * is to fail the sign-in cleanly, and a stack trace from GitHub's error shape
 * would tell a user nothing useful.
 */
export async function exchangeGithubCode(
  code: string,
  redirectUri: string,
): Promise<GithubProfile | null> {
  const clientId = env("GITHUB_CLIENT_ID");
  const clientSecret = env("GITHUB_CLIENT_SECRET");
  if (clientId === null || clientSecret === null) return null;

  try {
    const res = await fetch(TOKEN, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // Without this GitHub answers in form-encoding and the JSON parse
        // below silently yields nothing useful.
        accept: "application/json",
      },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: redirectUri,
      }),
      cache: "no-store",
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { access_token?: string };
    const accessToken = body.access_token;
    if (accessToken === undefined) return null;

    const me = await fetch(`${API}/user`, {
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
      },
      cache: "no-store",
    });
    if (!me.ok) return null;
    const u = (await me.json()) as {
      id?: number;
      login?: string;
      name?: string | null;
      avatar_url?: string | null;
    };
    if (u.id === undefined || u.login === undefined) return null;
    return {
      id: String(u.id),
      username: u.login,
      name: u.name ?? u.login,
      avatarUrl: u.avatar_url ?? null,
    };
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------- sessions */

function sessionKey(): Buffer | null {
  const secret = env("X_ATTESTATION_SIGNER_KEY");
  if (secret === null) return null;
  // Derived from the signer rather than a second secret, so there is one thing
  // to configure and one thing to rotate. Domain-separated so a session token
  // can never be mistaken for anything else signed with the same key.
  return createHmac("sha256", secret).update("arcanium:social-session:v1").digest();
}

export function newState(): string {
  return randomBytes(16).toString("base64url");
}

/**
 * A short-lived, signed note saying which account just proved itself.
 *
 * Carries the platform as well as the handle. Without it a session minted by
 * signing in to GitHub could be replayed against the X endpoints and claim the
 * X vault of the same name — the exact collision the namespaced key exists to
 * prevent, reintroduced one layer up.
 */
export function mintSocialSession(platform: string, id: string, username: string): string | null {
  const key = sessionKey();
  if (key === null) return null;
  const payload = Buffer.from(
    JSON.stringify({ p: platform, id, u: username, exp: Date.now() + SESSION_TTL_MS }),
  ).toString("base64url");
  const mac = createHmac("sha256", key).update(payload).digest("base64url");
  return `${payload}.${mac}`;
}

export function readSocialSession(
  token: string | undefined,
): { platform: string; id: string; username: string } | null {
  const key = sessionKey();
  if (key === null || token === undefined) return null;
  const [payload, mac] = token.split(".");
  if (payload === undefined || mac === undefined) return null;

  const expected = createHmac("sha256", key).update(payload).digest();
  let given: Buffer;
  try {
    given = Buffer.from(mac, "base64url");
  } catch {
    return null;
  }
  // Length first: timingSafeEqual throws on a mismatch rather than returning
  // false, which would be an exception where a rejection belongs.
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;

  try {
    const d = JSON.parse(Buffer.from(payload, "base64url").toString()) as {
      p?: string;
      id?: string;
      u?: string;
      exp?: number;
    };
    if (typeof d.exp !== "number" || Date.now() > d.exp) return null;
    if (typeof d.p !== "string" || typeof d.id !== "string" || typeof d.u !== "string") return null;
    return { platform: d.p, id: d.id, username: d.u };
  } catch {
    return null;
  }
}
