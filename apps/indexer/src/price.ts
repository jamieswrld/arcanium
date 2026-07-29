/**
 * Exact bigint Uniswap v3 price math shared by the indexer. Never uses JS
 * Number on monetary values (coding rule); mirrors the frontend's
 * apps/web/src/lib/launchpad.ts implementation.
 */
const Q192 = 2n ** 192n;

/** USD price per whole token scaled 1e18, 6-decimal quote / 18-decimal token. */
export function priceUsdE18(sqrtPriceX96: bigint, tokenIsToken0: boolean): bigint {
  const numerator = sqrtPriceX96 * sqrtPriceX96;
  if (numerator === 0n) return 0n;
  if (tokenIsToken0) {
    return (numerator * 10n ** 30n) / Q192;
  }
  return (10n ** 30n * Q192) / numerator;
}

/** Market cap in 6-decimal USD units for the fixed 1e9-token supply. */
export function marketCapUsdUnits(priceE18: bigint): bigint {
  return (priceE18 * 10n ** 15n) / 10n ** 18n;
}
