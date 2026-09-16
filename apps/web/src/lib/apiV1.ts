import { NextResponse } from "next/server";

/**
 * Shared primitives for the public Arcanium API (v1).
 *
 * Trust model, stated once and enforced everywhere below: **the contracts on Arc
 * are the source of truth.** This API is convenience infrastructure — a fast,
 * normalised read over indexed events. It never holds funds, never holds keys,
 * and never signs. The transaction endpoints return unsigned calldata for the
 * caller's own wallet to sign, and anything security-critical can and should be
 * verified by reading the chain directly.
 *
 * Every endpoint shares one envelope so a client can be written once:
 *
 *   success  { "data": ..., "meta": { ... } }
 *   failure  { "error": { "code": "...", "message": "...", "details": ... } }
 *
 * `code` is a stable machine-readable string. `message` is for humans and may
 * be reworded; never branch on it.
 */

export const API_VERSION = "v1";

/** Public read API: any origin may call it. No credentials are ever accepted,
 *  so there is no cookie or auth surface for a permissive origin to abuse. */
const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type",
  "access-control-max-age": "86400",
};

export type ErrorCode =
  | "bad_request"
  | "invalid_address"
  | "invalid_parameter"
  | "not_found"
  | "upstream_unavailable"
  | "rate_limited"
  | "internal";

const STATUS: Record<ErrorCode, number> = {
  bad_request: 400,
  invalid_address: 400,
  invalid_parameter: 400,
  not_found: 404,
  upstream_unavailable: 503,
  rate_limited: 429,
  internal: 500,
};

export interface Meta {
  readonly [key: string]: unknown;
}

/** A successful response. `maxAge` seconds of shared caching, 0 to disable. */
export function ok<T>(data: T, meta: Meta = {}, maxAge = 10): NextResponse {
  return NextResponse.json(
    { data, meta: { version: API_VERSION, ...meta } },
    {
      status: 200,
      headers: {
        ...CORS_HEADERS,
        "cache-control":
          maxAge > 0
            ? `public, s-maxage=${maxAge}, stale-while-revalidate=${maxAge * 6}`
            : "no-store",
      },
    },
  );
}

export function fail(code: ErrorCode, message: string, details?: unknown): NextResponse {
  return NextResponse.json(
    { error: { code, message, ...(details === undefined ? {} : { details }) } },
    { status: STATUS[code], headers: { ...CORS_HEADERS, "cache-control": "no-store" } },
  );
}

export function preflight(): NextResponse {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

/* ------------------------------------------------------------- validation --- */

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export function parseAddress(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const v = raw.trim();
  return ADDRESS.test(v) ? v.toLowerCase() : null;
}

/** Bounded integer parameter. Out-of-range values are clamped rather than
 *  rejected: a caller asking for 10,000 rows wants "as many as you'll give me". */
export function parseLimit(raw: string | null, fallback: number, max: number): number {
  if (raw === null || raw.trim() === "") return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(n, max);
}

export function parseOffset(raw: string | null): number {
  if (raw === null || raw.trim() === "") return 0;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/** One of a fixed set, or the fallback. Keeps enums from leaking into queries. */
export function parseEnum<T extends string>(
  raw: string | null,
  allowed: readonly T[],
  fallback: T,
): T {
  if (raw === null) return fallback;
  const v = raw.trim().toLowerCase() as T;
  return allowed.includes(v) ? v : fallback;
}

/* ---------------------------------------------------------------- shaping --- */

/**
 * JSON cannot carry a bigint, and a float cannot carry a token amount without
 * losing precision. Every on-chain quantity therefore leaves this API as a
 * decimal *string* in base units, alongside the decimals needed to scale it.
 * Clients that need arithmetic should parse to their own big-number type.
 */
export function units(value: bigint): string {
  return value.toString();
}

/** USD figures are indexed in 6-decimal micro-units; expose both so a caller
 *  never has to guess the scale. */
export function usd(microUnits: bigint): { readonly units: string; readonly decimals: number } {
  return { units: microUnits.toString(), decimals: 6 };
}

/* ------------------------------------------------------------ rate limit --- */

/**
 * Small in-process limiter.
 *
 * Deliberately modest: it blunts accidental hammering from a loop in someone's
 * integration, which is the realistic failure here. It is per-instance and so
 * not a defence against a distributed abuser — that belongs at the edge, and is
 * noted in the developer docs rather than pretended away.
 */
const WINDOW_MS = 60_000;
const buckets = new Map<string, { count: number; resetAt: number }>();

export function rateLimit(key: string, perMinute: number): { ok: boolean; retryAfter: number } {
  const now = Date.now();
  const bucket = buckets.get(key);
  if (bucket === undefined || now >= bucket.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return { ok: true, retryAfter: 0 };
  }
  bucket.count += 1;
  if (bucket.count > perMinute) {
    return { ok: false, retryAfter: Math.ceil((bucket.resetAt - now) / 1000) };
  }
  return { ok: true, retryAfter: 0 };
}

/** Best-effort client identity for the limiter. */
export function clientKey(request: Request): string {
  const h = request.headers;
  return (
    h.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    h.get("x-real-ip") ??
    "anonymous"
  );
}

/** Wraps a handler with rate limiting and a catch-all, so a thrown error never
 *  reaches a caller as a stack trace. */
export async function handle(
  request: Request,
  perMinute: number,
  fn: () => Promise<NextResponse>,
): Promise<NextResponse> {
  const limit = rateLimit(clientKey(request), perMinute);
  if (!limit.ok) {
    const res = fail("rate_limited", `Too many requests. Retry in ${limit.retryAfter}s.`);
    res.headers.set("retry-after", String(limit.retryAfter));
    return res;
  }
  try {
    return await fn();
  } catch (err) {
    // Never surface internals: a serialized RPC error or stack trace is both
    // useless to a caller and an information leak.
    console.error("[api/v1]", err);
    return fail("internal", "Something went wrong handling that request.");
  }
}
