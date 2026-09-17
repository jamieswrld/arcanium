import { NextResponse } from "next/server";
import { verifyMessage, type Hex } from "viem";
import { getDb } from "@/lib/db";
import { arcPublicClient } from "@/lib/launchpad";
import { logoMessage } from "@/lib/logoSignature";

/**
 * Token metadata store. POST persists the launch metadataUri (which carries the
 * logo) so it displays immediately, independent of indexer lag. Write-once per
 * token — the first writer (the launcher) wins, so nobody can overwrite a
 * token's logo. GET returns the stored metadataUri (or the indexer's, as a
 * fallback) for clients that want it directly.
 */

async function ensureTable(sql: NonNullable<ReturnType<typeof getDb>>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS token_metadata (
      token_address text PRIMARY KEY,
      metadata_uri  text NOT NULL,
      created_at    timestamptz NOT NULL DEFAULT now()
    )
  `;
}

export async function POST(
  request: Request,
  context: { params: Promise<{ token: string }> },
): Promise<NextResponse> {
  const { token } = await context.params;
  if (!/^0x[0-9a-fA-F]{40}$/.test(token)) {
    return NextResponse.json({ error: "invalid token" }, { status: 400 });
  }
  const sql = getDb();
  if (sql === null) return NextResponse.json({ ok: false, error: "no database" }, { status: 503 });

  const body = (await request.json().catch(() => null)) as { metadataUri?: unknown } | null;
  const uri = body?.metadataUri;
  if (typeof uri !== "string" || uri.length > 300_000 || !uri.startsWith("data:application/json")) {
    return NextResponse.json({ error: "invalid metadataUri" }, { status: 400 });
  }

  try {
    await ensureTable(sql);
    await sql`
      INSERT INTO token_metadata (token_address, metadata_uri)
      VALUES (${token.toLowerCase()}, ${uri})
      ON CONFLICT (token_address) DO NOTHING
    `;
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? (err.message.split("\n")[0] ?? "failed") : "failed";
    return NextResponse.json({ ok: false, error: message }, { status: 502 });
  }
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ token: string }> },
): Promise<NextResponse> {
  const { token } = await context.params;
  if (!/^0x[0-9a-fA-F]{40}$/.test(token)) {
    return NextResponse.json({ error: "invalid token" }, { status: 400 });
  }
  const sql = getDb();
  if (sql === null) return NextResponse.json({ metadataUri: null });
  try {
    const rows = await sql<{ metadata_uri: string }[]>`
      SELECT metadata_uri FROM token_metadata WHERE token_address = ${token.toLowerCase()} LIMIT 1
    `;
    // The launcher travels with the metadata so the token page can decide
    // whether to offer the logo control at all, in one request rather than
    // two. Null when it cannot be established — the control then stays hidden,
    // which is the right way round: a PUT would be refused anyway.
    const launcher = await launcherOf(token).catch(() => null);
    return NextResponse.json({ metadataUri: rows[0]?.metadata_uri ?? null, launcher });
  } catch {
    return NextResponse.json({ metadataUri: null, launcher: null });
  }
}


/**
 * Who is allowed to set this token's logo: the wallet that launched it.
 *
 * Not the factory's `creator` field, which stores the fee recipient — for a
 * social-vault launch that is a hashed address nobody holds a key to, so
 * asking it to sign would lock the real launcher out of their own token. The
 * launch transaction's sender is the wallet that actually did the launching,
 * whoever ends up collecting the fees.
 *
 * Returns null when the launch is not on record, which denies the write: an
 * unknown launcher is not an absent one, and treating it as absent would make
 * every unindexed token's logo free for the taking.
 */
async function launcherOf(token: string): Promise<Hex | null> {
  const sql = getDb();
  if (sql === null) return null;
  try {
    const rows = await sql<{ launch_tx_hash: Buffer }[]>`
      SELECT launch_tx_hash FROM tokens
      WHERE token_address = ${Buffer.from(token.slice(2), "hex")} LIMIT 1
    `;
    const row = rows[0];
    if (row === undefined) return null;
    const tx = await arcPublicClient().getTransaction({
      hash: `0x${row.launch_tx_hash.toString("hex")}` as Hex,
    });
    return tx.from;
  } catch {
    return null;
  }
}

/**
 * Set or replace a token's logo, signed by the wallet that launched it.
 *
 * POST is write-once and unauthenticated, which is why this exists. That was
 * a fair trade while the launch form always claimed the slot within a second
 * of the launch, but the first v4 launches never claimed theirs — the form
 * decoded only v3's `Launched` event and so never learned the token address —
 * and an unclaimed slot is claimable by anyone. A launcher can now take their
 * own token's logo back, and correct it later if they want to.
 *
 * The signature is checked with viem's `verifyMessage`, which validates a
 * contract signature (ERC-1271) as well as an EOA's, so a smart-account
 * launcher is not shut out.
 */
export async function PUT(
  request: Request,
  context: { params: Promise<{ token: string }> },
): Promise<NextResponse> {
  const { token } = await context.params;
  if (!/^0x[0-9a-fA-F]{40}$/.test(token)) {
    return NextResponse.json({ error: "invalid token" }, { status: 400 });
  }
  const sql = getDb();
  if (sql === null) return NextResponse.json({ ok: false, error: "no database" }, { status: 503 });

  const body = (await request.json().catch(() => null)) as
    | { metadataUri?: unknown; signature?: unknown }
    | null;
  const uri = body?.metadataUri;
  const signature = body?.signature;
  if (typeof uri !== "string" || uri.length > 300_000 || !uri.startsWith("data:application/json")) {
    return NextResponse.json({ error: "invalid metadataUri" }, { status: 400 });
  }
  if (typeof signature !== "string" || !/^0x[0-9a-fA-F]+$/.test(signature)) {
    return NextResponse.json({ error: "invalid signature" }, { status: 400 });
  }

  const launcher = await launcherOf(token);
  if (launcher === null) {
    // Distinct from a rejection: we could not establish who launched this, so
    // there is nobody to check the signature against. Saying "forbidden" would
    // tell the real launcher they are not the launcher.
    return NextResponse.json(
      { ok: false, error: "launch not on record; cannot verify ownership yet" },
      { status: 503 },
    );
  }

  const ok = await verifyMessage({
    address: launcher,
    message: logoMessage(token, uri),
    signature: signature as Hex,
  }).catch(() => false);
  if (!ok) {
    return NextResponse.json(
      { ok: false, error: "signature is not from the wallet that launched this token" },
      { status: 403 },
    );
  }

  try {
    await ensureTable(sql);
    await sql`
      INSERT INTO token_metadata (token_address, metadata_uri)
      VALUES (${token.toLowerCase()}, ${uri})
      ON CONFLICT (token_address) DO UPDATE SET metadata_uri = EXCLUDED.metadata_uri
    `;
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? (err.message.split("\n")[0] ?? "failed") : "failed";
    return NextResponse.json({ ok: false, error: message }, { status: 502 });
  }
}
