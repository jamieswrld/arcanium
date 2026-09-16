import { fail, handle, ok, parseAddress, parseEnum, parseLimit, parseOffset, preflight } from "@/lib/apiV1";
import { lockListResilient, lockStatsResilient, type LockStatus } from "@/lib/locks";

/**
 * GET /api/locks
 *
 *   ?token=0x…      locks holding this token
 *   ?wallet=0x…     locks this wallet created or will receive
 *   ?role=depositor|beneficiary|any
 *   ?status=locked|claimable|claimed|all
 *   ?limit= &offset=
 *   ?stats=1        headline counts instead of a page of locks
 *
 * Public and unauthenticated: a lock is a public commitment, and being able to
 * verify someone else's is most of the point.
 */
export const dynamic = "force-dynamic";
export const OPTIONS = preflight;

const STATUSES = ["locked", "claimable", "claimed", "all"] as const;
const ROLES = ["depositor", "beneficiary", "any"] as const;

export async function GET(request: Request): Promise<Response> {
  return handle(request, 120, async () => {
    const url = new URL(request.url);

    if (url.searchParams.get("stats") !== null) {
      const stats = await lockStatsResilient();
      if (stats === null) return fail("upstream_unavailable", "Lock data is not available.");
      return ok(stats);
    }

    const rawToken = url.searchParams.get("token");
    const rawWallet = url.searchParams.get("wallet");
    const token = rawToken === null ? undefined : (parseAddress(rawToken) ?? null);
    const wallet = rawWallet === null ? undefined : (parseAddress(rawWallet) ?? null);
    if (token === null) return fail("invalid_address", "token is not an address.");
    if (wallet === null) return fail("invalid_address", "wallet is not an address.");

    const limit = parseLimit(url.searchParams.get("limit"), 50, 200);
    const offset = parseOffset(url.searchParams.get("offset"));
    const status = parseEnum<(typeof STATUSES)[number]>(url.searchParams.get("status"), STATUSES, "all");
    const role = parseEnum<(typeof ROLES)[number]>(url.searchParams.get("role"), ROLES, "any");

    const result = await lockListResilient({
      token,
      wallet,
      role,
      status: status as LockStatus | "all",
      limit,
      offset,
    });
    // Null means the indexer could not answer. Saying "no locks" here would be
    // a different and much worse claim than saying we cannot tell.
    if (result === null) return fail("upstream_unavailable", "Lock data is not available.");

    return ok(result.locks, { total: result.total, limit, offset, status, role, source: result.source });
  });
}
