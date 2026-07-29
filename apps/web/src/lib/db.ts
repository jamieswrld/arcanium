import postgres from "postgres";

/**
 * Lazy Postgres client for the web app's read-only market endpoints. Returns
 * null when DATABASE_URL is unset so routes degrade to a 503 (the frontend
 * then falls back to bounded on-chain reads).
 */
let client: ReturnType<typeof postgres> | null | undefined;

export function getDb(): ReturnType<typeof postgres> | null {
  if (client !== undefined) return client;
  const url = process.env["DATABASE_URL"];
  client = url !== undefined && url.length > 0 ? postgres(url, { max: 3 }) : null;
  return client;
}
