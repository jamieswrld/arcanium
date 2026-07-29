/**
 * Exact decimal conversion utilities. All Arch financial math flows through
 * bigint — JavaScript floats are never used on monetary values (coding rule).
 */

export const BPS_DENOMINATOR = 10_000n;

/**
 * Parse a human decimal string (e.g. "12.34") into raw integer units at the
 * given decimals. Rejects malformed input and excess fractional digits rather
 * than rounding silently.
 */
export function parseUnits(value: string, decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 77) {
    throw new RangeError(`invalid decimals: ${decimals}`);
  }
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (match === null) {
    throw new SyntaxError(`invalid decimal string: ${JSON.stringify(value)}`);
  }
  const sign = match[1] === "-" ? -1n : 1n;
  const whole = match[2] ?? "0";
  const frac = match[3] ?? "";
  if (frac.length > decimals) {
    throw new RangeError(
      `too many fractional digits (${frac.length}) for ${decimals} decimals`,
    );
  }
  const scaled =
    BigInt(whole) * 10n ** BigInt(decimals) +
    BigInt(frac.padEnd(decimals, "0") || "0");
  return sign * scaled;
}

/**
 * Format raw integer units as a human decimal string with no precision loss
 * and no floats. Trailing fractional zeros are trimmed.
 */
export function formatUnits(value: bigint, decimals: number): string {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 77) {
    throw new RangeError(`invalid decimals: ${decimals}`);
  }
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = abs % base;
  const fracStr =
    decimals === 0
      ? ""
      : frac.toString().padStart(decimals, "0").replace(/0+$/, "");
  const body = fracStr.length > 0 ? `${whole}.${fracStr}` : whole.toString();
  return negative ? `-${body}` : body;
}

/** amount * bps / 10_000, truncating toward zero (fee-taker rounding). */
export function applyBps(amount: bigint, bps: bigint): bigint {
  if (bps < 0n || bps > BPS_DENOMINATOR) {
    throw new RangeError(`bps out of range: ${bps}`);
  }
  return (amount * bps) / BPS_DENOMINATOR;
}

/** amount minus its bps share — e.g. net-of-fee deposit amounts. */
export function subtractBps(amount: bigint, bps: bigint): bigint {
  return amount - applyBps(amount, bps);
}
