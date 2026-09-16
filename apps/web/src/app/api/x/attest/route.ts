import { cookies } from "next/headers";
import { fail, handle, ok, parseAddress, preflight } from "@/lib/apiV1";
import { readSession, xUserIdHash, xPayoutsConfigured } from "@/lib/xIdentity";
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
    inputs: [{ type: "bytes32" }, { type: "address" }],
    outputs: [{ type: "address" }],
  },
] as const;

export async function POST(request: Request): Promise<Response> {
  return handle(request, 30, async () => {
    if (!xPayoutsConfigured()) {
      return fail("upstream_unavailable", "X payouts are not configured on this deployment.");
    }

    const jar = await cookies();
    const session = readSession(jar.get("x_session")?.value);
    if (session === null) {
      return fail("bad_request", "Verify your X account first — the session is missing or expired.");
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

    const idHash = xUserIdHash(session.id);

    // Derived on chain from the factory rather than computed here, so the
    // address this signs over is exactly the one the factory would deploy.
    const client = arcPublicClient();
    const vault = (await client
      .readContract({
        address: ARC_XCREATOR.factory,
        abi: factoryAbi,
        functionName: "vaultFor",
        args: [idHash, token as Hex],
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
