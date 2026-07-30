/**
 * Token logo. Renders the real uploaded image when there is one; otherwise a
 * neutral grey placeholder — never a generated gradient or initials, so the UI
 * only ever shows genuine token art. Pure markup: safe in server components.
 */
export function TokenAvatar({
  image,
  symbol,
  size = 36,
  radius = 10,
}: {
  readonly image: string | null | undefined;
  readonly symbol: string;
  readonly size?: number;
  readonly radius?: number;
}) {
  const hasImage = image !== null && image !== undefined && image !== "";
  return (
    <span
      aria-hidden
      title={hasImage ? undefined : symbol}
      style={{
        width: size,
        height: size,
        borderRadius: radius,
        flexShrink: 0,
        display: "block",
        overflow: "hidden",
        // Grey placeholder shows through until (or unless) the image paints.
        background: "var(--muted)",
        border: "1px solid color-mix(in oklch, var(--border) 70%, transparent)",
      }}
    >
      {hasImage ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={image}
          alt=""
          loading="lazy"
          decoding="async"
          style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
        />
      ) : null}
    </span>
  );
}
