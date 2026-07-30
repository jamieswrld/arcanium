/** Inline mode icons — no external assets, theme-aware via currentColor. */

/** Arcane Mode: a wizard wand alight at the tip (buy & burn). */
export function ArcaneWandIcon({ size = 28 }: { readonly size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden style={{ display: "block", flexShrink: 0 }}>
      <defs>
        <linearGradient id="arc-flame" x1="0" y1="1" x2="0" y2="0">
          <stop offset="0%" stopColor="#f59e0b" />
          <stop offset="55%" stopColor="#fb923c" />
          <stop offset="100%" stopColor="#fde68a" />
        </linearGradient>
      </defs>
      {/* wand shaft, angled */}
      <path d="M6 26.5 19 13.5" stroke="#a78bfa" strokeWidth="3.2" strokeLinecap="round" />
      <path d="M6 26.5 19 13.5" stroke="#ffffff" strokeWidth="1" strokeLinecap="round" opacity="0.35" />
      {/* grip band */}
      <path d="M9.2 23.3 12 20.5" stroke="#6d28d9" strokeWidth="3.4" strokeLinecap="round" />
      {/* flame at the tip */}
      <path
        d="M21.6 12.4c1.9-1.6 2.3-3.6 1.6-5.5 2.6 1.3 4.6 3.9 4.6 6.7 0 3-2.4 5.2-5.2 5.2s-5.2-2.1-5.2-4.9c0-1.5.7-2.8 1.7-3.7-.2 1.4.4 2.5 2.5 2.2z"
        fill="url(#arc-flame)"
      />
      {/* sparks */}
      <circle cx="26.5" cy="5.5" r="1.05" fill="#fde68a" />
      <circle cx="17.6" cy="6.8" r="0.75" fill="#fbbf24" />
    </svg>
  );
}

/** Divium: a stack of dollar bills (creator fees paid out to holders). */
export function DiviumBillsIcon({ size = 28 }: { readonly size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden style={{ display: "block", flexShrink: 0 }}>
      {/* back bills */}
      <rect x="4" y="8.5" width="24" height="11" rx="2.2" fill="#166534" />
      <rect x="4" y="11.5" width="24" height="11" rx="2.2" fill="#15803d" />
      {/* front bill */}
      <rect x="4" y="14.5" width="24" height="11" rx="2.2" fill="#22c55e" />
      <rect x="5.6" y="16.1" width="20.8" height="7.8" rx="1.4" fill="none" stroke="#dcfce7" strokeWidth="0.9" opacity="0.85" />
      {/* centre medallion + $ */}
      <circle cx="16" cy="20" r="3.3" fill="#166534" opacity="0.45" />
      <path
        d="M16.55 17.5v.72c.86.12 1.5.6 1.62 1.42h-1.02c-.08-.36-.4-.6-.9-.6-.56 0-.9.24-.9.62 0 .3.24.5.86.62l.6.12c1 .2 1.5.66 1.5 1.44 0 .86-.64 1.4-1.66 1.52v.72h-.86v-.72c-.96-.12-1.62-.64-1.72-1.5h1.04c.1.44.48.72 1.12.72.62 0 1-.24 1-.68 0-.32-.24-.54-.86-.66l-.64-.14c-.94-.2-1.42-.64-1.42-1.38 0-.78.6-1.32 1.48-1.44v-.72h.76z"
        fill="#f0fdf4"
      />
    </svg>
  );
}
