import type { Hex } from "viem";
import { getDb } from "@/lib/db";
import type { Platform } from "@/lib/socialIdentity";

/**
 * Putting a name to a creator-fee vault address.
 *
 * A vault address is a hash of `platform:handle`, and hashes do not run
 * backwards — so a token page that knows only its fee recipient can show
 * 0x1bbd…2dA3 and nothing else, which tells a reader nothing about who is
 * being paid. This records the pairing at the one moment both halves are
 * known: when the API derives a vault from a handle somebody typed.
 *
 * It is an index for the interface, never a source of truth. The chain decides
 * where fees go. An address that is not recorded here is rendered as an
 * address — never guessed at, and never labelled with a handle we are not sure
 * of, because attributing someone else's fee stream to the wrong account is a
 * worse failure than showing hex.
 */

export interface VaultOwner {
  readonly platform: Platform;
  readonly handle: string;
}

/** Note that this vault belongs to this handle. Best-effort and never throws. */
export async function rememberVault(vault: Hex, platform: Platform, handle: string): Promise<void> {
  const sql = getDb();
  if (sql === null) return;
  try {
    await sql`
      INSERT INTO social_vaults (vault_address, platform, handle)
      VALUES (${Buffer.from(vault.slice(2), "hex")}, ${platform}, ${handle.toLowerCase()})
      ON CONFLICT (vault_address) DO NOTHING
    `;
  } catch {
    // A missing index costs a label, not correctness. Never let it break the
    // request that was actually asked for.
  }
}

/** Whose vault this is, or null when we have never been told. */
export async function vaultOwner(address: string): Promise<VaultOwner | null> {
  const sql = getDb();
  if (sql === null) return null;
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return null;
  try {
    const rows = await sql<{ platform: string; handle: string }[]>`
      SELECT platform, handle FROM social_vaults
      WHERE vault_address = ${Buffer.from(address.slice(2), "hex")}
      LIMIT 1
    `;
    const row = rows[0];
    if (row === undefined) return null;
    if (row.platform !== "x" && row.platform !== "github") return null;
    return { platform: row.platform, handle: row.handle };
  } catch {
    return null;
  }
}

/** Where to send someone who wants to see the account itself. */
export function profileUrl(platform: Platform, handle: string): string {
  return platform === "github" ? `https://github.com/${handle}` : `https://x.com/${handle}`;
}
