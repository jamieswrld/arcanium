import { parseAbiItem } from "viem";
import { getDb } from "@/lib/db";
import { chainPublicClient } from "@/lib/chainRpc";
import { getChain, type ChainKey, type LaunchChain } from "@/lib/chains";

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
 *  a just-launched token's logo appears as soon as it's stored.
 *
 *  NOTE: keys must be chain-scoped. Our factory deploys to the same address on
 *  every chain, so the first launch on each chain gets the SAME token address --
 *  an address-keyed cache serves one chain's logo for another chain's token. */
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

/**
 * On-chain fallback.
 *
 * The DB mirror is only a cache: the logo is embedded in the launch's
 * metadataUri and lives on-chain forever. Two Robinhood launches showed blank
 * avatars because the fire-and-forget mirror write never landed, even though
 * both images were sitting in their Launched events all along. Reading the
 * chain makes logos survive a failed write, a wiped table, or a new chain the
 * mirror has never seen.
 *
 * One getLogs per chain (not per token), memoised, then matched to addresses.
 */
const LAUNCHED_EVENT = parseAbiItem(
  "event Launched(address indexed token, address indexed creator, address pairToken, address pool, uint256 positionId, string metadataUri)",
);
const CHAIN_IMAGES_TTL_MS = 300_000;
const LOOKBACK_BLOCKS = 400_000n;
const chainImages = new Map<ChainKey, { at: number; map: Record<string, string> }>();

async function imagesFromChain(chain: LaunchChain): Promise<Record<string, string>> {
  const hit = chainImages.get(chain.key);
  if (hit !== undefined && Date.now() - hit.at < CHAIN_IMAGES_TTL_MS) return hit.map;

  const map: Record<string, string> = {};
  try {
    const client = chainPublicClient(chain);
    const head = await client.getBlockNumber();
    const from = head > LOOKBACK_BLOCKS ? head - LOOKBACK_BLOCKS : 0n;
    const logs = await Promise.all(
      chain.factories.map((address) =>
        client
          .getLogs({ address, event: LAUNCHED_EVENT, fromBlock: from, toBlock: head })
          .catch(() => []),
      ),
    );
    for (const log of logs.flat()) {
      const token = log.args.token;
      const img = decodeImage(log.args.metadataUri);
      if (token !== undefined && img !== null) map[token.toLowerCase()] = img;
    }
  } catch {
    // leave empty — the UI falls back to a gradient avatar
  }
  chainImages.set(chain.key, { at: Date.now(), map });
  return map;
}

/** Logos for one chain's tokens: DB mirror first, then the chain itself. */
export async function fetchTokenImagesOn(
  tokens: readonly string[],
  chain: LaunchChain,
): Promise<Record<string, string>> {
  // The chain is consulted FIRST and wins. The token_metadata mirror is keyed by
  // address only, and addresses repeat across chains (same factory address, same
  // nonce), so trusting it first would serve one chain's logo for another's
  // token -- exactly what happened with TEST on Robinhood and MONKE on BNB.
  const onChain = await imagesFromChain(chain);
  const out: Record<string, string> = {};
  const missing: string[] = [];
  for (const t of tokens) {
    const img = onChain[t.toLowerCase()];
    if (img !== undefined) out[t.toLowerCase()] = img;
    else missing.push(t);
  }
  if (missing.length === 0) return out;

  const fromDb = await fetchTokenImages(missing).catch(() => ({}) as Record<string, string>);
  return { ...fromDb, ...out };
}

/** Logos for a mixed-chain list, one chain lookup each, all in parallel. */
export async function fetchImagesForChainTokens(
  tokens: readonly { readonly token: string; readonly chainKey: ChainKey }[],
): Promise<Record<string, string>> {
  if (tokens.length === 0) return {};
  const byChain = new Map<ChainKey, string[]>();
  for (const t of tokens) {
    const list = byChain.get(t.chainKey);
    if (list === undefined) byChain.set(t.chainKey, [t.token]);
    else list.push(t.token);
  }
  const results = await Promise.all(
    [...byChain.entries()].map(([key, addrs]) =>
      fetchTokenImagesOn(addrs, getChain(key)).catch(() => ({}) as Record<string, string>),
    ),
  );
  return Object.assign({}, ...results) as Record<string, string>;
}

/** Everything a creator attached at launch. All of it lives on-chain in the
 *  launch's metadataUri, so it survives regardless of the DB mirror. */
export interface TokenMeta {
  readonly image: string | null;
  readonly description: string | null;
  readonly website: string | null;
  readonly twitter: string | null;
  readonly telegram: string | null;
  readonly discord: string | null;
}

const EMPTY_META: TokenMeta = {
  image: null, description: null, website: null, twitter: null, telegram: null, discord: null,
};

/** Only ever surface links we would be willing to click: https, nothing else.
 *  A metadataUri is creator-controlled input, so javascript:/data: must never
 *  reach an href. */
function safeUrl(v: unknown): string | null {
  if (typeof v !== "string" || v.trim() === "") return null;
  try {
    const u = new URL(v.trim());
    return u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
}

function decodeMeta(uri: string | null | undefined): TokenMeta {
  if (uri === null || uri === undefined || uri === "") return EMPTY_META;
  try {
    const b64 = uri.split(",")[1];
    if (b64 === undefined) return EMPTY_META;
    const p = JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as Record<string, unknown>;
    const img = typeof p["image"] === "string" && (p["image"].startsWith("data:image") || p["image"].startsWith("https://"))
      ? (p["image"] as string)
      : null;
    const desc = typeof p["description"] === "string" && p["description"].trim() !== ""
      ? (p["description"] as string).slice(0, 600)
      : null;
    return {
      image: img,
      description: desc,
      website: safeUrl(p["website"]),
      twitter: safeUrl(p["twitter"]),
      telegram: safeUrl(p["telegram"]),
      discord: safeUrl(p["discord"]),
    };
  } catch {
    return EMPTY_META;
  }
}

const META_TTL_MS = 300_000;
const chainMeta = new Map<ChainKey, { at: number; map: Record<string, TokenMeta> }>();

async function metaFromChain(chain: LaunchChain): Promise<Record<string, TokenMeta>> {
  const hit = chainMeta.get(chain.key);
  if (hit !== undefined && Date.now() - hit.at < META_TTL_MS) return hit.map;
  const map: Record<string, TokenMeta> = {};
  try {
    const client = chainPublicClient(chain);
    const head = await client.getBlockNumber();
    const from = head > LOOKBACK_BLOCKS ? head - LOOKBACK_BLOCKS : 0n;
    const logs = await Promise.all(
      chain.factories.map((address) =>
        client.getLogs({ address, event: LAUNCHED_EVENT, fromBlock: from, toBlock: head }).catch(() => []),
      ),
    );
    for (const log of logs.flat()) {
      const token = log.args.token;
      if (token !== undefined) map[token.toLowerCase()] = decodeMeta(log.args.metadataUri);
    }
  } catch {
    // fall through to empty
  }
  chainMeta.set(chain.key, { at: Date.now(), map });
  return map;
}

/** Full launch metadata for one token: DB mirror first, then the chain. */
export async function fetchTokenMeta(token: string, chain: LaunchChain): Promise<TokenMeta> {
  const key = token.toLowerCase();
  // Chain first, for the address-collision reason above.
  const onChain = (await metaFromChain(chain))[key];
  if (onChain !== undefined) return onChain;
  const sql = getDb();
  if (sql !== null) {
    try {
      const rows = await sql<{ metadata_uri: string }[]>`
        SELECT metadata_uri FROM token_metadata WHERE token_address = ${key} LIMIT 1
      `;
      const uri = rows[0]?.metadata_uri;
      if (uri !== undefined) return decodeMeta(uri);
    } catch {
      // mirror unavailable — the chain is authoritative anyway
    }
  }
  return EMPTY_META;
}
