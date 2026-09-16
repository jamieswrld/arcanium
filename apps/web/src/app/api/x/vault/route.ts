import { fail, handle, ok, parseAddress, preflight } from "@/lib/apiV1";
import { resolveUsername, xUserIdHash, xPayoutsConfigured } from "@/lib/xIdentity";
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
    if (!xPayoutsConfigured()) {
      return fail("upstream_unavailable", "X payouts are not configured on this deployment.");
    }
    const url = new URL(request.url);
    const username = url.searchParams.get("username") ?? "";
    const profile = await resolveUsername(username);
    if (profile === null) return fail("not_found", `Could not resolve @${username.replace(/^@/, "")}.`);

    const idHash = xUserIdHash(profile.id);
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

    return ok({
      vault,
      deployed: code !== undefined && code !== "0x",
      xUserIdHash: idHash,
      username: profile.username,
      xUserId: profile.id,
      claimable: { units: (balance as bigint).toString(), decimals: 6 },
    });
  });
}
