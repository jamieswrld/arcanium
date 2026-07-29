/**
 * Arch design tokens. Original visual system: light default with restrained
 * Arc-inspired cues (deep indigo primary, warm neutral surfaces). Never reuse
 * Envelope assets or CSS.
 */
export const archTheme = {
  color: {
    primary: "#3730a3",
    primaryHover: "#312e81",
    accent: "#0e7490",
    surface: "#ffffff",
    surfaceMuted: "#f7f7f5",
    border: "#e5e4e0",
    text: "#1c1b1a",
    textMuted: "#6b6a66",
    positive: "#15803d",
    negative: "#b91c1c",
    warning: "#b45309",
  },
  radius: {
    card: "12px",
    control: "8px",
    pill: "999px",
  },
  font: {
    body: "'Inter', system-ui, -apple-system, sans-serif",
    mono: "'JetBrains Mono', ui-monospace, monospace",
  },
} as const;

export type ArchTheme = typeof archTheme;
