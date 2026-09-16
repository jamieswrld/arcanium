import { cookies } from "next/headers";
import { fail, handle, ok, parseAddress, preflight } from "@/lib/apiV1";
import { readSession, xPayoutsConfigured } from "@/lib/xIdentity";
import { githubConfigured, readSocialSession } from "@/lib/githubIdentity";
import { identityKey, isPlatform } from "@/lib/socialIdentity";
import { pinHandle } from "@/lib/xPins";
import { signClaim } from "@/lib/xAttest";
import { arcPublicClient } from "@/lib/launchpad";
import { ARC_XCREATOR } from "@arch/chain-config";
import type { Hex } from "viem";

/**
 * POST /api/x/attest  { token, recipient }
 *
 * Signs an authorisation to release one vault's balance to one wallet.
 *
 * The identity comes from the session cookie, never from the request body: the
 * whole security of this rests on the caller having completed OAuth, and a body
 * field would let anyone name any identity. The vault address is derived from
 * that identity and the token, not accepted from the client, so a caller cannot
 * point an attestation at somebody else's vault.
 *
 * The signature alone does not move funds. The vault additionally requires the
 * claim to be sent by the named recipient, so this endpoint cannot be used to
 * pay an attacker.
 */
export const dynamic = "force-dynamic";
export const OPTIONS = preflight;

const factoryAbi = [
  {
    type: "function",
    name: "vaultFor",
    stateMutability: "view",
    inputs: [{ type: "bytes32" }],
    outputs: [{ type: "address" }],
  },
] as const;

export async function POST(request: Request): Promise<Response> {
  return handle(request, 30, async () => {
    // Either provider being configured is enough; the session decides which
    // one is actually used, and that is checked again below.
    if (!xPayoutsConfigured() && !githubConfigured()) {
      return fail("upstream_unavailable", "Social payouts are not configured on this deployment.");
    }

    const jar = await cookies();
    // Either provider's session is accepted; which one it is decides the
    // vault. The X session predates the platform field, so it is read with the
    // older reader and labelled explicitly rather than assumed.
    const gh = readSocialSession(jar.get("gh_session")?.value);
    const x = gh === null ? readSession(jar.get("x_session")?.value) : null;
    const session =
      gh !== null
        ? gh
        : x === null
          ? null
          : { platform: "x", id: x.id, username: x.username };
    if (session === null) {
      return fail("bad_request", "Verify your account first — the session is missing or expired.");
    }

    let body: { token?: unknown; recipient?: unknown };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return fail("bad_request", "Body must be JSON.");
    }

    const token = parseAddress(typeof body.token === "string" ? body.token : null);
    const recipient = parseAddress(typeof body.recipient === "string" ? body.recipient : null);
    if (token === null) return fail("invalid_address", "token must be an address.");
    if (recipient === null) return fail("invalid_address", "recipient must be an address.");

    // The vault is addressed by the handle the session actually holds — and by
    // the platform that session was earned on. A caller cannot name either, so
    // a request cannot point itself at somebody else's vault by asking.
    //
    // The platform half matters as much as the handle. Without it, a session
    // minted by signing in to GitHub would work against the X vault of the
    // same name, which is precisely the collision the namespaced key exists to
    // prevent — only reintroduced one layer up.
    const handle = session.username.toLowerCase();
    if (!isPlatform(session.platform)) return fail("bad_request", "Unknown identity provider.");
    const platform = session.platform;

    const configured = platform === "x" ? xPayoutsConfigured() : githubConfigured();
    if (!configured) {
      return fail("upstream_unavailable", "That identity provider is not configured here.");
    }

    const idHash = identityKey(platform, handle);

    // The pin: whoever claims a handle first owns it from then on. A handle
    // that later changes hands is worth nothing to whoever takes it, because
    // their numeric id will not match the one recorded here. Scoped per
    // platform, so the same name on each is two independent claims.
    const pin = await pinHandle(`${platform}:${handle}`, session.id, recipient as Hex);
    if (!pin.ok) {
      return fail(
        "bad_request",
        `${handle} is already claimed by a different account on that platform. Handles can change hands, so the first account to claim one keeps it.`,
      );
    }

    // Derived on chain from the factory rather than computed here, so the
    // address this signs over is exactly the one the factory would deploy.
    const client = arcPublicClient();
    const vault = (await client
      .readContract({
        address: ARC_XCREATOR.factory,
        abi: factoryAbi,
        functionName: "vaultFor",
        args: [idHash],
      })
      .catch(() => null)) as Hex | null;
    if (vault === null) return fail("upstream_unavailable", "Could not reach Arc to derive the vault.");

    const attestation = await signClaim({
      xUserIdHash: idHash,
      vault,
      token: token as Hex,
      recipient: recipient as Hex,
    });
    if (attestation === null) return fail("internal", "Attestation signing is unavailable.");

    // Never cached: it is single-use, short-lived and specific to one wallet.
    return ok({ ...attestation, username: session.username }, {}, 0);
  });
}
