import { keccak256, toBytes, type Hex } from "viem";

/**
 * Which social account a creator-fee vault belongs to.
 *
 * The vault contracts key on an opaque bytes32 and never interpret it, so what
 * that hash is *of* is decided entirely here. That makes this file the one
 * place where two platforms could collide, and the reason it exists.
 *
 * ── Why the platform is part of the hash ────────────────────────────────────
 * X vaults originally hashed the bare handle. Adding a second platform makes
 * that unsafe: GitHub's `alice` and X's `@alice` are different people who
 * would have hashed to the same key, and therefore to the same vault — so
 * whichever of them claimed first would collect the other's fees. There is no
 * way to detect that after the fact, because by then the two are literally the
 * same address.
 *
 * Prefixing with the platform fixes it, and it was safe to change because no
 * vault had ever been deployed and no launch pointed at one. Checked on chain
 * before changing it rather than assumed.
 *
 * Lowercased because both platforms treat handles case-insensitively for
 * identity purposes, and two vaults for one account would split its fees.
 */

export type Platform = "x" | "github";

export const PLATFORMS: readonly Platform[] = ["x", "github"];

interface PlatformRules {
  readonly label: string;
  /** What a valid handle looks like, from the platform's own rules. */
  readonly pattern: RegExp;
  readonly maxLength: number;
}

const RULES: Record<Platform, PlatformRules> = {
  // X: 1–15 characters, letters, digits and underscore.
  x: { label: "X", pattern: /^[A-Za-z0-9_]{1,15}$/, maxLength: 15 },
  // GitHub: 1–39 characters, alphanumeric and single hyphens, never leading or
  // trailing. Their own signup rule, and worth enforcing here so a handle that
  // cannot exist never gets a vault pointed at it.
  github: {
    label: "GitHub",
    pattern: /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/,
    maxLength: 39,
  },
};

export function platformLabel(platform: Platform): string {
  return RULES[platform].label;
}

export function isPlatform(value: string): value is Platform {
  return (PLATFORMS as readonly string[]).includes(value);
}

/** Strip decoration a person might paste: a leading @, or a profile URL. */
export function normaliseHandle(platform: Platform, raw: string): string {
  let h = raw.trim();
  h = h.replace(/^https?:\/\/(www\.)?(x\.com|twitter\.com|github\.com)\//i, "");
  h = h.replace(/^@/, "").replace(/\/.*$/, "");
  return h.toLowerCase().slice(0, RULES[platform].maxLength);
}

export function isValidHandle(platform: Platform, raw: string): boolean {
  const h = raw.trim().replace(/^@/, "");
  return RULES[platform].pattern.test(h);
}

/**
 * The vault key: the platform and the handle, hashed together.
 *
 * `x:alice` and `github:alice` are deliberately different keys. Never hash a
 * bare handle here — that is the collision described above.
 */
export function identityKey(platform: Platform, rawHandle: string): Hex {
  const handle = normaliseHandle(platform, rawHandle);
  if (!isValidHandle(platform, handle)) {
    throw new Error(`not a valid ${RULES[platform].label} handle`);
  }
  return keccak256(toBytes(`${platform}:${handle}`));
}
