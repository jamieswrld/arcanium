/** USDC roundel (drawn inline — no external asset): the familiar blue coin
 *  with a white dollar mark and orbit dashes. Used wherever USDC on Arc shows. */
export function UsdcLogo({ size = 34 }: { readonly size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden style={{ flexShrink: 0, display: "block" }}>
      <circle cx="16" cy="16" r="16" fill="#2775CA" />
      {/* orbit dashes */}
      <path d="M13 27.6c-5.2-1.3-9-6-9-11.6S7.8 5.7 13 4.4" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" opacity="0.95" />
      <path d="M19 4.4c5.2 1.3 9 6 9 11.6s-3.8 10.3-9 11.6" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" opacity="0.95" />
      {/* dollar glyph */}
      <path
        d="M16.9 8.7v1.5c1.9.3 3.3 1.4 3.5 3.2h-2.1c-.2-.9-.9-1.5-2.2-1.5-1.4 0-2.2.6-2.2 1.6 0 .8.6 1.3 2 1.6l1.4.3c2.3.5 3.4 1.5 3.4 3.3 0 2-1.5 3.2-3.8 3.5v1.5h-1.8v-1.5c-2.2-.3-3.6-1.5-3.8-3.5h2.1c.2 1.1 1.1 1.8 2.7 1.8 1.5 0 2.4-.6 2.4-1.7 0-.8-.6-1.4-2-1.7l-1.5-.3c-2.2-.5-3.3-1.5-3.3-3.2 0-1.8 1.4-3 3.4-3.3V8.7h1.8z"
        fill="#fff"
      />
    </svg>
  );
}
