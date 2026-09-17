import { fail, handle, ok, parseAddress, preflight } from "@/lib/apiV1";
import { resolveUsername, xPayoutsConfigured } from "@/lib/xIdentity";
import { githubConfigured } from "@/lib/githubIdentity";
import { identityKey, isPlatform, isValidHandle, normaliseHandle, platformLabel } from "@/lib/socialIdentity";
import { rememberVault } from "@/lib/socialVaults";
import { arcPublicClient } from "@/lib/launchpad";
import { ARC_XCREATOR, ARC_USDC } from "@arch/chain-config";
import { erc20Abi, type Hex } from "viem";

/**
 * GET /api/x/vault?username=alice
 *
 * Where a given X account's creator fees live, whether that vault has been
 * deployed, and what is sitting in it. One vault per identity, across every
 * launch that names it — so no token parameter.
 *
 * The address is real before the contract exists — it is a CREATE2 address, so
 * a launch can name it as its fee recipient immediately and the vault is only
 * deployed when somebody claims. `deployed: false` with a non-zero balance is
 * the normal, expected state, not an error.
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

export async function GET(request: Request): Promise<Response> {
  return handle(request, 60, async () => {
    const url = new URL(request.url);

    // Defaults to X so every existing caller keeps working unchanged.
    const raw = (url.searchParams.get("platform") ?? "x").toLowerCase();
    if (!isPlatform(raw)) {
      return fail("invalid_parameter", "`platform` must be x or github.");
    }
    const platform = raw;

    const configured = platform === "x" ? xPayoutsConfigured() : githubConfigured();
    if (!configured) {
      return fail(
        "upstream_unavailable",
        `${platformLabel(platform)} payouts are not configured on this deployment.`,
      );
    }

    const username = url.searchParams.get("username") ?? "";
    if (!isValidHandle(platform, username)) {
      return fail("invalid_parameter", `Not a valid ${platformLabel(platform)} handle.`);
    }
    const handleName = normaliseHandle(platform, username);

    // X can additionally confirm the account exists when an app-only token is
    // configured; GitHub needs no lookup because the vault is keyed on the
    // handle either way. A handle that is well-formed but unverified is
    // reported as such rather than dressed up as resolved.
    let numericId: string | null = null;
    if (platform === "x") {
      const profile = await resolveUsername(handleName);
      if (profile === null) return fail("not_found", `Could not resolve @${handleName}.`);
      numericId = profile.id;
    }

    const idHash = identityKey(platform, handleName);
    const client = arcPublicClient();
    const vault = (await client
      .readContract({
        address: ARC_XCREATOR.factory,
        abi: factoryAbi,
        functionName: "vaultFor",
        args: [idHash],
      })
      .catch(() => null)) as Hex | null;
    if (vault === null) return fail("upstream_unavailable", "Could not reach Arc.");

    const [code, balance] = await Promise.all([
      client.getCode({ address: vault }).catch(() => undefined),
      client
        .readContract({ address: ARC_USDC, abi: erc20Abi, functionName: "balanceOf", args: [vault] })
        .catch(() => 0n),
    ]);

    // Note the pairing while both halves are in hand. A hash does not run
    // backwards, so without this a token page can only ever show the fee
    // recipient as hex.
    void rememberVault(vault, platform, handleName);

    return ok({
      platform,
      vault,
      deployed: code !== undefined && code !== "0x",
      // Kept under the original name so existing integrations do not break,
      // even though it is no longer a hash of an X id specifically.
      xUserIdHash: idHash,
      identityKey: idHash,
      username: handleName,
      xUserId: numericId,
      claimable: { units: (balance as bigint).toString(), decimals: 6 },
    });
  });
}
