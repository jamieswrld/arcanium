import { getDb } from "@/lib/db";

/**
 * Logo lookup for launched tokens. Images are captured at launch (embedded in
 * the on-chain metadataUri and mirrored into the token_metadata table for
 * instant, cheap reads). Everything degrades gracefully to no-image → the UI
 * falls back to a gradient avatar.
 */

/** Decode the `image` field out of a data:application/json;base64 metadataUri. */
function decodeImage(uri: string | null | undefined): string | null {
  if (uri === null || uri === undefined || uri === "") return null;
  try {
    const b64 = uri.split(",")[1];
    if (b64 === undefined) return null;
    const parsed = JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as { image?: unknown };
    const img = parsed.image;
    if (typeof img !== "string") return null;
    return img.startsWith("data:image") || img.startsWith("https://") ? img : null;
  } catch {
    return null;
  }
}

/** Map of lowercased token address → logo (data URI or https). Missing = no logo. */
export async function fetchTokenImages(tokens: readonly string[]): Promise<Record<string, string>> {
  const sql = getDb();
  if (sql === null || tokens.length === 0) return {};
  const keys = tokens.map((t) => t.toLowerCase());
  const out: Record<string, string> = {};
  try {
    const rows = await sql<{ token_address: string; metadata_uri: string }[]>`
      SELECT token_address, metadata_uri FROM token_metadata WHERE token_address = ANY(${keys})
    `;
    for (const r of rows) {
      const img = decodeImage(r.metadata_uri);
      if (img !== null) out[r.token_address.toLowerCase()] = img;
    }
  } catch {
    // table may not exist yet (no launches through the UI) — no logos.
  }
  return out;
}

export async function fetchTokenImage(token: string): Promise<string | null> {
  return (await fetchTokenImages([token]))[token.toLowerCase()] ?? null;
}
