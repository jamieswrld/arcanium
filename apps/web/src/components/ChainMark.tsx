import type { LaunchChain } from "@/lib/chains";

/**
 * Arc's mark — the real one, from Circle's own asset, never an approximation.
 * Only 46x48 is published, so it is used at small sizes only.
 */
export function ChainMark({ chain, size = 18 }: { readonly chain: LaunchChain; readonly size?: number }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src="/logos/arc.png"
      alt=""
      title={chain.name}
      width={size}
      height={size}
      aria-hidden
      style={{ display: "block", flexShrink: 0, borderRadius: "50%", objectFit: "contain" }}
    />
  );
}

/** Small inline chain badge. */
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

/** The quote asset's real logo — Circle's USDC. */
export function QuoteMark({ chain, size = 16 }: { readonly chain: LaunchChain; readonly size?: number }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src="/logos/usdc.png"
      alt={chain.quote.symbol}
      title={chain.quote.symbol}
      width={size}
      height={size}
      style={{ display: "inline-block", verticalAlign: "-0.15em", flexShrink: 0, borderRadius: "50%" }}
    />
  );
}
