import { fail, handle, ok, preflight } from "@/lib/apiV1";
import { resolveUsername, xPayoutsConfigured, xUserIdHash } from "@/lib/xIdentity";

/**
 * GET /api/x/resolve?username=alice
 *
 * Turns a handle into the stable numeric identity a vault can be bound to.
 * Rate limited hard: it is an unauthenticated proxy onto X's API, and the point
 * of it is lookup, not enumeration.
 */
export const dynamic = "force-dynamic";
export const OPTIONS = preflight;

export async function GET(request: Request): Promise<Response> {
  return handle(request, 20, async () => {
    if (!xPayoutsConfigured()) {
      return fail("upstream_unavailable", "X payouts are not configured on this deployment.");
    }
    const username = new URL(request.url).searchParams.get("username") ?? "";
    const profile = await resolveUsername(username);
    // No such account, or X would not say. Either way a launch must not
    // proceed: binding fees to an identity we could not confirm exists is the
    // one failure mode with no recovery.
    if (profile === null) return fail("not_found", `Could not resolve @${username.replace(/^@/, "")}.`);

    return ok(
      {
        id: profile.id,
        username: profile.username,
        name: profile.name,
        verified: profile.verified,
        profileImageUrl: profile.profileImageUrl,
        xUserIdHash: xUserIdHash(profile.id),
      },
      {},
      60,
    );
  });
}
