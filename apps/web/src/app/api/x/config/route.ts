import { fail, handle, ok, preflight } from "@/lib/apiV1";
import { xPayoutsConfigured } from "@/lib/xIdentity";
import { githubConfigured } from "@/lib/githubIdentity";
import { attestationSignerAddress } from "@/lib/xAttest";
import { ARC_XCREATOR } from "@arch/chain-config";

/**
 * Whether X payouts are usable right now.
 *
 * The UI asks this instead of a build-time flag, so the option disappears the
 * moment the credentials are missing rather than offering a path that dead-ends
 * at the launch transaction. `signerMatches` is the check that actually
 * matters: a configured key that is not the one the deployed factory trusts
 * would produce signatures every vault rejects.
 */
export const dynamic = "force-dynamic";
export const OPTIONS = preflight;

export async function GET(request: Request): Promise<Response> {
  return handle(request, 240, async () => {
    const configured = xPayoutsConfigured();
    const signer = attestationSignerAddress();
    const signerMatches =
      signer !== null && signer.toLowerCase() === ARC_XCREATOR.attestationSigner.toLowerCase();
    const github = githubConfigured();
    if (!configured && !github) {
      return ok({
        enabled: false,
        github: false,
        reason: "Social payouts are not configured on this deployment.",
        factory: ARC_XCREATOR.factory,
      });
    }
    if (!signerMatches) {
      return fail(
        "internal",
        "The configured attestation key is not the signer the deployed factory trusts.",
      );
    }
    return ok({ enabled: configured, github, reason: null, factory: ARC_XCREATOR.factory });
  });
}
