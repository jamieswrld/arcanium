import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";

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
    return NextResponse.json({ metadataUri: rows[0]?.metadata_uri ?? null });
  } catch {
    return NextResponse.json({ metadataUri: null });
  }
}
