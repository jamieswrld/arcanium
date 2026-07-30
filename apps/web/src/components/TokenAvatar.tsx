/**
 * Token logo avatar. Shows the uploaded image when one exists, otherwise a
 * gradient tile with the ticker initials. Pure markup — safe in server
 * components.
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
  if (image !== null && image !== undefined && image !== "") {
    return (
      <span
        aria-hidden
        style={{
          width: size,
          height: size,
          borderRadius: radius,
          flexShrink: 0,
          display: "block",
          background: `center/cover no-repeat url(${JSON.stringify(image)})`,
        }}
      />
    );
  }
  return (
    <span
      aria-hidden
      style={{
        width: size,
        height: size,
        borderRadius: radius,
        flexShrink: 0,
        background: "var(--brand-gradient)",
        color: "#fff",
        display: "grid",
        placeItems: "center",
        fontWeight: 700,
        fontSize: size > 44 ? "1rem" : "0.85rem",
      }}
    >
      {symbol.slice(0, 2)}
    </span>
  );
}
