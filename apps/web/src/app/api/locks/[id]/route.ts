import { fail, handle, ok, preflight } from "@/lib/apiV1";
import { lockById } from "@/lib/locks";

/** GET /api/locks/:id — one lock by its on-chain id. */
export const dynamic = "force-dynamic";
export const OPTIONS = preflight;

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handle(request, 120, async () => {
    const { id } = await context.params;
    // Ids are uint256 on chain, so they are validated as digits rather than
    // parsed into a Number that would silently lose precision.
    if (!/^[0-9]{1,78}$/.test(id)) return fail("invalid_parameter", "lock id must be a number.");

    const lock = await lockById(id);
    if (lock === null) return fail("not_found", `No lock ${id}.`);
    return ok(lock);
  });
}
