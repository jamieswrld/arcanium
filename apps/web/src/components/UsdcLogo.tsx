/**
 * USDC roundel — Circle's real mark, shipped locally.
 *
 * This used to be an inline approximation drawn by hand. It is now the genuine
 * asset from Circle's registry entry, so what users see matches the coin they
 * actually hold. See ChainMark's QuoteMark for the other quote assets.
 */
export function UsdcLogo({ size = 34 }: { readonly size?: number }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src="/logos/usdc.png"
      alt="USDC"
      width={size}
      height={size}
      style={{ flexShrink: 0, display: "block", borderRadius: "50%" }}
    />
  );
}
