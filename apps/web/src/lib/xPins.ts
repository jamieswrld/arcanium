import type { Hex } from "viem";
import { getDb } from "@/lib/db";

/**
 * Which X account owns a handle-keyed vault.
 *
 * Vaults are addressed by the lowercased handle, which is what lets a launch
 * name one before anybody has ever signed in — but handles change hands, and
 * without this the person who registers @alice after the original @alice
 * abandons it would inherit her fee stream.
 *
 * So the first account to claim a handle records its numeric id, and every
 * later attestation for that handle has to come from the same id. A handle
 * that changes hands after its owner has claimed once is worth nothing to
 * whoever takes it.
 *
 * The window this does not close is a handle abandoned before its owner ever
 * claimed. That is real, and the documentation says so rather than implying
 * the pin is airtight.
 *
 * This is enforced by the signer rather than by the vault, which is where the
 * trust already sat: the signer has always chosen which wallet an identity
 * maps to, and the docs have always said it is not trustless.
 */

export type PinResult =
  | { readonly ok: true; readonly firstClaim: boolean }
  | { readonly ok: false; readonly pinnedTo: string };

/**
 * Claim the handle for `xUserId`, or confirm it already belongs to them.
 *
 * The insert is conditional in one statement rather than a read followed by a
 * write: two people claiming the same handle in the same instant would both
 * see it free and both be allowed through.
 */
export async function pinHandle(
  handle: string,
  xUserId: string,
  recipient: Hex,
): Promise<PinResult> {
  const sql = getDb();
  // No database means the pin cannot be recorded, and signing without one is
  // the exact failure this exists to prevent — so it refuses rather than
  // quietly falling back to the unprotected behaviour.
  if (sql === null) return { ok: false, pinnedTo: "unavailable" };
  const h = handle.trim().replace(/^@/, "").toLowerCase();

  const rows = await sql<{ x_user_id: string; inserted: boolean }[]>`
    WITH attempt AS (
      INSERT INTO x_vault_pins (handle, x_user_id, first_recipient)
      VALUES (${h}, ${xUserId}, ${Buffer.from(recipient.slice(2), "hex")})
      ON CONFLICT (handle) DO NOTHING
      RETURNING x_user_id, true AS inserted
    )
    SELECT x_user_id, inserted FROM attempt
    UNION ALL
    SELECT x_user_id, false AS inserted FROM x_vault_pins WHERE handle = ${h}
    LIMIT 1
  `;

  const row = rows[0];
  // No row at all means the write failed rather than that the handle is taken.
  // Refusing is the safe reading: signing here would hand out an attestation
  // with no pin recorded, which is the one outcome this exists to prevent.
  if (row === undefined) return { ok: false, pinnedTo: "unknown" };
  if (row.x_user_id !== xUserId) return { ok: false, pinnedTo: row.x_user_id };
  return { ok: true, firstClaim: row.inserted };
}

/** Who owns a handle, or null when nobody has claimed it yet. */
export async function pinnedOwner(handle: string): Promise<string | null> {
  const sql = getDb();
  if (sql === null) return null;
  const h = handle.trim().replace(/^@/, "").toLowerCase();
  const rows = await sql<{ x_user_id: string }[]>`
    SELECT x_user_id FROM x_vault_pins WHERE handle = ${h} LIMIT 1
  `;
  return rows[0]?.x_user_id ?? null;
}
