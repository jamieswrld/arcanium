/**
 * Arcanium iconography.
 *
 * One flat monoline set on the brand violet, generated as a matched family and
 * checked by eye before shipping. Deliberately not emoji: emoji render
 * differently on every platform, carry another vendor's art direction, and read
 * as decoration rather than interface.
 *
 * Kept as images rather than inline SVG because they are illustrative marks
 * with consistent internal detail, not currentColor glyphs. They are 96px and
 * ~10KB each, which covers every use at 3x.
 *
 * The exported names match the previous hand-drawn components so every call
 * site keeps working.
 */

type IconProps = { readonly size?: number | undefined; readonly title?: string | undefined };

function Icon({
  src,
  alt,
  size = 20,
  title,
}: {
  readonly src: string;
  readonly alt: string;
  readonly size?: number | undefined;
  readonly title?: string | undefined;
}) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt={alt}
      title={title ?? alt}
      width={size}
      height={size}
      loading="lazy"
      decoding="async"
      style={{ display: "block", flexShrink: 0, objectFit: "contain" }}
    />
  );
}

/** Divium — creator fees are distributed to holders. */
export function DiviumBillsIcon({ size, title }: IconProps) {
  return <Icon src="/icons/divium.png" alt="Divium" size={size} title={title ?? "Divium"} />;
}

/** Arcane — creator fees buy the token on the market and burn it. */
export function ArcaneWandIcon({ size, title }: IconProps) {
  return <Icon src="/icons/arcane.png" alt="Arcane" size={size} title={title ?? "Arcane"} />;
}

/** Standard — creator fees are paid straight to a wallet. */
export function StandardWalletIcon({ size, title }: IconProps) {
  return <Icon src="/icons/standard.png" alt="Standard" size={size} title={title ?? "Standard"} />;
}

/** Creator rewards / claimable fees. */
export function RewardsIcon({ size, title }: IconProps) {
  return <Icon src="/icons/rewards.png" alt="Creator rewards" size={size} title={title ?? "Creator rewards"} />;
}
