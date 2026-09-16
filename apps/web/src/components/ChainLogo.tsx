import type { ReactNode } from "react";

/**
 * Chain marks for the bridge picker.
 *
 * Drawn inline rather than loaded as files. A dozen brand PNGs would be a
 * dozen network requests on a control that has to feel instant, and hotlinking
 * someone's CDN makes our interface break when they reorganise theirs.
 *
 * Where a chain's mark is simple geometry — Ethereum's octahedron, Avalanche's
 * triangle, Polygon's hexagon — it is drawn. Where it is lettering or an
 * intricate custom glyph, this renders a brand-coloured monogram instead of a
 * bad freehand copy: an approximate logo reads as a broken logo, while a
 * monogram reads as a deliberate one. Dropping real SVGs in later only means
 * replacing the entry in MARKS.
 */

export interface ChainMark {
  readonly bg: string;
  readonly fg: string;
  /** Drawn mark, in a 24×24 viewBox. Omitted means use the monogram. */
  readonly art?: ReactNode;
  readonly monogram?: string;
}

const MARKS: Record<string, ChainMark> = {
  arc: {
    bg: "#0B0B0F",
    fg: "#FFFFFF",
    monogram: "A",
  },
  ethereum: {
    bg: "#627EEA",
    fg: "#FFFFFF",
    art: (
      <g fill="none" fillRule="evenodd">
        <path d="M12 4v5.9l4.99 2.23z" fill="#FFF" fillOpacity={0.9} />
        <path d="M12 4L7 12.13l5-2.23z" fill="#FFF" />
        <path d="M12 16.48V20l5-6.94z" fill="#FFF" fillOpacity={0.9} />
        <path d="M12 20v-3.52L7 13.06z" fill="#FFF" />
        <path d="M12 15.55l4.99-2.92L12 10.4z" fill="#FFF" fillOpacity={0.5} />
        <path d="M7 12.63l5 2.92V10.4z" fill="#FFF" fillOpacity={0.7} />
      </g>
    ),
  },
  base: {
    bg: "#0052FF",
    fg: "#FFFFFF",
    // A disc with a flat left edge, which is Base's mark.
    art: <path d="M12 6a6 6 0 010 12H8.6V6H12z" fill="#FFF" />,
  },
  arbitrum: {
    bg: "#213147",
    fg: "#12AAFF",
    art: (
      <g>
        <path d="M12 4l6.5 3.75v8.5L12 20l-6.5-3.75v-8.5L12 4z" fill="none" stroke="#12AAFF" strokeWidth={1.3} />
        <path d="M11.2 9.1l3.4 6.6h-2l-2.4-4.9-1 1.9 1.5 3h-2l-1.1-2.2 3.6-6.9z" fill="#FFF" />
      </g>
    ),
  },
  optimism: {
    bg: "#FF0420",
    fg: "#FFFFFF",
    monogram: "OP",
  },
  polygon: {
    bg: "#8247E5",
    fg: "#FFFFFF",
    art: (
      <path
        d="M12 5.2l5.6 3.23v6.46L12 18.12 6.4 14.9V8.43L12 5.2zm0 2.2L8.3 9.54v4.62L12 16.3l3.7-2.14V9.54L12 7.4z"
        fill="#FFF"
      />
    ),
  },
  avalanche: {
    bg: "#E84142",
    fg: "#FFFFFF",
    art: (
      <g fill="#FFF">
        <path d="M12.9 7.6c.5-.86 1.3-.86 1.8 0l3.5 6.1c.5.86.1 1.56-.9 1.56h-7c-1 0-1.4-.7-.9-1.56l3.5-6.1z" />
        <path d="M8.2 11.1c.44-.78 1.16-.78 1.6 0l.7 1.24c.3.55.3 1.2 0 1.75l-.7 1.24c-.44.78-1.16.78-1.6 0l-.7-1.24a1.8 1.8 0 010-1.75l.7-1.24z" />
      </g>
    ),
  },
  unichain: { bg: "#FF007A", fg: "#FFFFFF", monogram: "U" },
  linea: { bg: "#121212", fg: "#61DFFF", monogram: "L" },
  sonic: { bg: "#FE9A4D", fg: "#101010", monogram: "S" },
  worldchain: { bg: "#111111", fg: "#FFFFFF", monogram: "W" },
  sei: { bg: "#9D1B1B", fg: "#FFFFFF", monogram: "SEI" },
};

const FALLBACK: ChainMark = { bg: "#2A2A32", fg: "#FFFFFF", monogram: "?" };

export function ChainLogo({
  chainKey,
  name,
  size = 18,
}: {
  readonly chainKey: string;
  readonly name?: string;
  readonly size?: number;
}) {
  const mark = MARKS[chainKey] ?? FALLBACK;
  const label = mark.monogram ?? (name ?? chainKey).slice(0, 1).toUpperCase();
  // Long monograms have to shrink or they overflow the disc.
  const fontSize = label.length >= 3 ? 7.5 : label.length === 2 ? 9 : 11.5;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      role="img"
      aria-label={name ?? chainKey}
      style={{ flex: "0 0 auto", display: "block", borderRadius: "50%" }}
    >
      <circle cx={12} cy={12} r={12} fill={mark.bg} />
      {mark.art ?? (
        <text
          x={12}
          y={12}
          textAnchor="middle"
          dominantBaseline="central"
          fontSize={fontSize}
          fontWeight={700}
          fill={mark.fg}
          fontFamily="var(--font-sans, system-ui), sans-serif"
        >
          {label}
        </text>
      )}
    </svg>
  );
}
