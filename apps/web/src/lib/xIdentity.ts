import "server-only";
import { createHmac, randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { keccak256, toBytes, type Hex } from "viem";

/**
 * X identity, server side only.
 *
 * Everything here exists to keep one rule: a username typed into a browser is
 * never proof of anything. The only identity that binds money is X's stable
 * numeric user ID, resolved server-to-server, and the only thing that proves
 * control of it is an OAuth round trip that the browser cannot forge.
 *
 * Usernames change hands. Someone who launches a token as @alice today may be
 * @bob tomorrow, and @alice may belong to a stranger. Keying a fee stream off
 * the handle would quietly transfer the money with the name, so the vault is
 * bound to keccak256 of the numeric ID and the handle is only ever a label.
 *
 * No secret in this file is ever exposed to the client. The module is
 * `server-only` so an accidental import from a component fails the build
 * rather than shipping a key.
 */

export interface XProfile {
  /** X's stable numeric user ID, as a decimal string. */
  readonly id: string;
  readonly username: string;
  readonly name: string;
  readonly verified: boolean;
  readonly profileImageUrl: string | null;
}

const API = "https://api.x.com/2";

function env(name: string): string | null {
  const v = process.env[name];
  return v === undefined || v.trim() === "" ? null : v.trim();
}

/**
 * Whether X payouts can work at all right now.
 *
 * Checked rather than assumed, because the feature is useless without X's API
 * and half-working is worse than absent: a creator who picks "X account" and
 * cannot have it resolved must be stopped at the form, not at the transaction.
 */
export function xPayoutsConfigured(): boolean {
  return (
    env("X_CLIENT_ID") !== null &&
    env("X_CLIENT_SECRET") !== null &&
    env("X_BEARER_TOKEN") !== null &&
    env("X_ATTESTATION_SIGNER_KEY") !== null
  );
}

/** The identity a vault is permanently bound to. */
export function xUserIdHash(numericId: string): Hex {
  if (!/^[0-9]{1,25}$/.test(numericId)) throw new Error("x user id must be numeric");
  return keccak256(toBytes(numericId));
}

/**
 * Resolve a handle to the account behind it, right now.
 *
 * App-only auth, so this works without the user being present — it is used at
 * launch time, when the X account's owner may be someone the launcher has never
 * met. Returns null for anything that is not a real, resolvable account.
 */
export async function resolveUsername(username: string): Promise<XProfile | null> {
  const bearer = env("X_BEARER_TOKEN");
  if (bearer === null) return null;
  const handle = username.trim().replace(/^@/, "");
  // X's own rule: 1-15 characters, letters, digits and underscore.
  if (!/^[A-Za-z0-9_]{1,15}$/.test(handle)) return null;

  try {
    const res = await fetch(
      `${API}/users/by/username/${handle}?user.fields=verified,profile_image_url,name`,
      { headers: { authorization: `Bearer ${bearer}` }, cache: "no-store" },
    );
    if (!res.ok) return null;
    const body = (await res.json()) as {
      data?: { id?: string; username?: string; name?: string; verified?: boolean; profile_image_url?: string };
    };
    const d = body.data;
    if (d?.id === undefined || d.username === undefined) return null;
    return {
      id: d.id,
      username: d.username,
      name: d.name ?? d.username,
      verified: d.verified ?? false,
      profileImageUrl: d.profile_image_url ?? null,
    };
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------ OAuth (PKCE) */

export interface PkcePair {
  readonly verifier: string;
  readonly challenge: string;
  readonly state: string;
}

/**
 * A fresh PKCE pair and CSRF state.
 *
 * PKCE matters here even though there is a client secret: the authorization
 * code travels back through the user's browser, and without a verifier that
 * never left the server, anyone who intercepted the redirect could redeem it.
 */
export function newPkce(): PkcePair {
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge, state: randomBytes(24).toString("base64url") };
}

export function authorizeUrl(challenge: string, state: string, redirectUri: string): string | null {
  const clientId = env("X_CLIENT_ID");
  if (clientId === null) return null;
  const p = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    // users.read is the whole requirement: we need the numeric id and nothing
    // else. Asking for more would be asking people to grant more than the
    // feature uses.
    scope: "users.read tweet.read",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  return `https://x.com/i/oauth2/authorize?${p.toString()}`;
}

/** Exchange an authorization code for the authenticated account. */
export async function exchangeCode(
  code: string,
  verifier: string,
  redirectUri: string,
): Promise<XProfile | null> {
  const clientId = env("X_CLIENT_ID");
  const clientSecret = env("X_CLIENT_SECRET");
  if (clientId === null || clientSecret === null) return null;

  try {
    const tokenRes = await fetch(`${API}/oauth2/token`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        code_verifier: verifier,
      }),
      cache: "no-store",
    });
    if (!tokenRes.ok) return null;
    const { access_token } = (await tokenRes.json()) as { access_token?: string };
    if (access_token === undefined) return null;

    const meRes = await fetch(`${API}/users/me?user.fields=verified,profile_image_url,name`, {
      headers: { authorization: `Bearer ${access_token}` },
      cache: "no-store",
    });
    if (!meRes.ok) return null;
    const body = (await meRes.json()) as {
      data?: { id?: string; username?: string; name?: string; verified?: boolean; profile_image_url?: string };
    };
    const d = body.data;
    if (d?.id === undefined || d.username === undefined) return null;
    return {
      id: d.id,
      username: d.username,
      name: d.name ?? d.username,
      verified: d.verified ?? false,
      profileImageUrl: d.profile_image_url ?? null,
    };
  } catch {
    return null;
  }
}

/* ---------------------------------------------------------------- sessions */

/**
 * A short-lived proof that this browser completed the OAuth round trip.
 *
 * Signed rather than stored: the only thing it needs to carry is "this browser
 * proved control of X user N until time T", and a server-side session table
 * would be state to keep for no benefit. Keyed off the attestation signer's own
 * secret so there is one secret to manage, and scoped so it cannot be replayed
 * as anything else.
 */
const SESSION_TTL_MS = 15 * 60_000;

function sessionKey(): Buffer | null {
  const k = env("X_ATTESTATION_SIGNER_KEY");
  return k === null ? null : createHash("sha256").update(`x-session:${k}`).digest();
}

export function mintSession(profile: XProfile): string | null {
  const key = sessionKey();
  if (key === null) return null;
  const payload = Buffer.from(
    JSON.stringify({ id: profile.id, u: profile.username, exp: Date.now() + SESSION_TTL_MS }),
  ).toString("base64url");
  const mac = createHmac("sha256", key).update(payload).digest("base64url");
  return `${payload}.${mac}`;
}

export function readSession(token: string | undefined): { id: string; username: string } | null {
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
  // Constant time, and length-checked first because timingSafeEqual throws on
  // a length mismatch rather than returning false.
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;

  try {
    const d = JSON.parse(Buffer.from(payload, "base64url").toString()) as {
      id?: string;
      u?: string;
      exp?: number;
    };
    if (d.id === undefined || d.u === undefined || typeof d.exp !== "number") return null;
    if (Date.now() > d.exp) return null;
    return { id: d.id, username: d.u };
  } catch {
    return null;
  }
}
