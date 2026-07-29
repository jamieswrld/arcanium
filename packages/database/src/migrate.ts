import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import postgres from "postgres";

/**
 * Minimal forward-only SQL migration runner. Applied filenames are recorded in
 * schema_migrations; files are applied in lexicographic order inside a
 * transaction each.
 */
export async function runMigrations(databaseUrl: string): Promise<string[]> {
  const sql = postgres(databaseUrl, { max: 1 });
  const applied: string[] = [];
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `;
    const migrationsDir = join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "migrations",
    );
    const files = (await readdir(migrationsDir))
      .filter((f) => f.endsWith(".sql"))
      .sort();
    for (const file of files) {
      const already = await sql`
        SELECT 1 FROM schema_migrations WHERE filename = ${file}
      `;
      if (already.length > 0) continue;
      const body = await readFile(join(migrationsDir, file), "utf8");
      await sql.begin(async (tx) => {
        await tx.unsafe(body);
        await tx`INSERT INTO schema_migrations (filename) VALUES (${file})`;
      });
      applied.push(file);
    }
  } finally {
    await sql.end();
  }
  return applied;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, "/")}`).href;

if (invokedDirectly) {
  const url = process.env["DATABASE_URL"];
  if (url === undefined || url.length === 0) {
    console.error("DATABASE_URL is required");
    process.exit(1);
  }
  runMigrations(url)
    .then((applied) => {
      console.log(
        applied.length > 0
          ? `applied: ${applied.join(", ")}`
          : "no pending migrations",
      );
    })
    .catch((err: unknown) => {
      console.error(err);
      process.exit(1);
    });
}
