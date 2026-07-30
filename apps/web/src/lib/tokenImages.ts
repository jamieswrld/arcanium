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

/** Logos are write-once: positive hits cache forever; misses expire quickly so
 *  a just-launched token's logo appears as soon as it's stored. */
const NEGATIVE_TTL_MS = 30_000;
const imageStore = new Map<string, { img: string | null; at: number }>();
const imageCache = {
  get(k: string): string | null | undefined {
    const e = imageStore.get(k);
    if (e === undefined) return undefined;
    if (e.img === null && Date.now() - e.at > NEGATIVE_TTL_MS) return undefined;
    return e.img;
  },
  set(k: string, img: string | null): void {
    imageStore.set(k, { img, at: Date.now() });
  },
};

/** Map of lowercased token address → logo (data URI or https). Missing = no logo. */
export async function fetchTokenImages(tokens: readonly string[]): Promise<Record<string, string>> {
  const sql = getDb();
  if (sql === null || tokens.length === 0) return {};
  const cached: Record<string, string> = {};
  const misses: string[] = [];
  for (const t of tokens) {
    const k = t.toLowerCase();
    const hit = imageCache.get(k);
    if (hit === undefined) misses.push(k);
    else if (hit !== null) cached[k] = hit;
  }
  if (misses.length === 0) return cached;
  const keys = misses;
  const out: Record<string, string> = cached;
  try {
    const rows = await sql<{ token_address: string; metadata_uri: string }[]>`
      SELECT token_address, metadata_uri FROM token_metadata WHERE token_address = ANY(${keys})
    `;
    const found = new Set<string>();
    for (const r of rows) {
      const k = r.token_address.toLowerCase();
      found.add(k);
      const img = decodeImage(r.metadata_uri);
      imageCache.set(k, img);
      if (img !== null) out[k] = img;
    }
    // Negative-cache misses so unlogo'd tokens don't re-query every render.
    for (const k of keys) if (!found.has(k)) imageCache.set(k, null);
  } catch {
    // table may not exist yet (no launches through the UI) — no logos.
  }
  return out;
}

export async function fetchTokenImage(token: string): Promise<string | null> {
  return (await fetchTokenImages([token]))[token.toLowerCase()] ?? null;
}
