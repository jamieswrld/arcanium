import type { LaunchChain } from "@/lib/chains";

/**
 * Chain glyphs — the real brand marks, never approximations.
 *
 * Sources, all verified by eye before shipping:
 *   Arc        docs.arc.network favicon (Circle's gradient arch). Only 46x48 is
 *              published, so it is used at small sizes only.
 *   Robinhood  simple-icons, the official single-path feather, brand #CCFF00.
 *   BNB        Trust Wallet asset registry, the official BNB Chain cube.
 *
 * Robinhood is inlined as a path so it can take a colour; the other two are
 * multi-colour brand art and ship as files. Everything is local — no third-party
 * host can break or track our chrome.
 */
export function ChainMark({ chain, size = 18 }: { readonly chain: LaunchChain; readonly size?: number }) {
  if (chain.key === "robinhood") {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill={chain.accent}
        aria-hidden
        style={{ display: "block", flexShrink: 0 }}
      >
        <path d="M2.84 24h.53c.096 0 .192-.048.224-.128C7.591 13.696 11.94 8.656 14.67 5.638c.112-.128.064-.225-.096-.225h-4.88a.55.55 0 0 0-.45.225L5.746 9.972c-.514.642-.642 1.236-.642 2.086v4.43c-1.14 3.194-1.862 5.361-2.392 7.32-.032.125.016.192.129.192M20.447.646c-.754-.802-4.157-.834-5.73-.224a3 3 0 0 0-.786.465 41 41 0 0 0-3.323 3.178c-.112.113-.064.225.097.225h5.409c.497 0 .786.289.786.786v6.1c0 .16.128.208.225.064l3.258-4.254c.53-.69.69-.898.835-1.861.192-1.413.08-3.58-.77-4.479m-6.982 16.18 2.231-3.676a.7.7 0 0 0 .064-.29V6.73c0-.16-.112-.225-.224-.097-3.355 3.74-5.971 7.672-8.395 12.407-.06.12.016.225.16.177l5.009-1.54c.565-.174.882-.402 1.155-.852" />
      </svg>
    );
  }

  const src = chain.key === "bnb" ? "/logos/bnb.png" : "/logos/arc.png";
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt=""
      width={size}
      height={size}
      aria-hidden
      style={{ display: "block", flexShrink: 0, borderRadius: "50%", objectFit: "contain" }}
    />
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

/**
 * The quote asset's real logo — Circle's USDC, Global Dollar's G, Tether's T.
 * Sizes match ChainMark so they sit together cleanly.
 */
export function QuoteMark({ chain, size = 16 }: { readonly chain: LaunchChain; readonly size?: number }) {
  const src =
    chain.quote.symbol === "USDG"
      ? "/logos/usdg.png"
      : chain.quote.symbol === "USDT"
        ? "/logos/usdt.png"
        : "/logos/usdc.png";
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt={chain.quote.symbol}
      title={chain.quote.symbol}
      width={size}
      height={size}
      style={{ display: "inline-block", verticalAlign: "-0.15em", flexShrink: 0, borderRadius: "50%" }}
    />
  );
}
