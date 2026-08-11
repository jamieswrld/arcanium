import type { LaunchChain } from "@/lib/chains";

/**
 * Chain glyph. Each chain gets a simple, recognisable mark rather than a remote
 * logo file, so badges render instantly and never depend on a third-party host.
 */
export function ChainMark({ chain, size = 18 }: { readonly chain: LaunchChain; readonly size?: number }) {
  const common = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    "aria-hidden": true as const,
    style: { display: "block", flexShrink: 0 },
  };

  if (chain.key === "bnb") {
    // BNB's rotated-diamond cluster.
    return (
      <svg {...common} fill={chain.accent}>
        <path d="M12 2 8.4 5.6 12 9.2l3.6-3.6zM5.6 8.4 2 12l3.6 3.6L9.2 12zm12.8 0L14.8 12l3.6 3.6L22 12zM12 14.8 8.4 18.4 12 22l3.6-3.6z" />
        <circle cx="12" cy="12" r="2.1" />
      </svg>
    );
  }

  if (chain.key === "robinhood") {
    // Robinhood's feather.
    return (
      <svg {...common} fill="none" stroke={chain.accent} strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
        <path d="M4 20c0-6 3-11 9-13 3-1 6-1 7 0 1 1 .5 4-1 7-2.5 5-7 7-11 7H4z" />
        <path d="M4 20 14 9" />
      </svg>
    );
  }

  // Arc — the Arcanium arc.
  return (
    <svg {...common} fill="none" stroke={chain.accent} strokeWidth="2" strokeLinecap="round">
      <path d="M3.5 18a8.5 8.5 0 0 1 17 0" />
      <circle cx="12" cy="18" r="1.9" fill={chain.accent} stroke="none" />
    </svg>
  );
}

/** Small inline chain badge for token cards and detail headers. */
export function ChainBadge({ chain }: { readonly chain: LaunchChain }) {
  return (
    <span
      className="arch-chain-badge"
      title={`Launched on ${chain.name}`}
      style={{ ["--chain-accent" as string]: chain.accent }}
    >
      <ChainMark chain={chain} size={12} />
      {chain.shortName}
    </span>
  );
}
