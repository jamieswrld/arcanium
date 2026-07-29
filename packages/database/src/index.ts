import postgres from "postgres";

export type Sql = ReturnType<typeof postgres>;

export interface DatabaseOptions {
  readonly url: string;
  readonly max?: number;
}

/**
 * Create a postgres.js client configured for Arch conventions:
 * - NUMERIC columns surface as strings and are converted with BigInt at the
 *   edge — never parsed as floats.
 * - BYTEA columns carry addresses/hashes as Buffers.
 */
export function createDatabase(options: DatabaseOptions): Sql {
  return postgres(options.url, {
    max: options.max ?? 10,
    // Keep NUMERIC as text so callers convert with BigInt, never Number.
    types: {
      numeric: {
        to: 1700,
        from: [1700],
        serialize: (value: string | bigint): string => value.toString(),
        parse: (value: string): string => value,
      },
    },
  });
}

/** Convert a NUMERIC(78,0) string column to bigint. Throws on non-integers. */
export function numericToBigint(value: string): bigint {
  return BigInt(value);
}

export { runMigrations } from "./migrate.js";
