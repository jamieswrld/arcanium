"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * Product navigation.
 *
 * Desktop: a compact horizontal nav in the topbar — the launch/trade loop is
 * the product, so navigation stays out of its way.
 *
 * Mobile: the same destinations become a bottom bar. Not a hamburger; on a
 * trading surface the primary destinations must stay one thumb-tap away.
 *
 * Bridge is deliberately absent from both. It is a funding utility, not part of
 * the launch/trade loop, so it lives in the footer and on the launch form where
 * a user actually discovers they need USDC.
 *
 * Launching is the one destination that is not a peer of the others: it is the
 * thing the product exists for, and it is what a visitor with an idea came to
 * do. So it leaves the link row and becomes a button — see LaunchButton. It is
 * labelled "Launch" rather than "Create" to match the form's own CTA, and
 * because a launchpad launches.
 */

const LAUNCH = { href: "/create", label: "Launch", icon: LaunchIcon } as const;

const DESTINATIONS = [
  { href: "/", label: "Explore", icon: ExploreIcon },
  { href: "/portfolio", label: "Portfolio", icon: PortfolioIcon },
  { href: "/activity", label: "Activity", icon: ActivityIcon },
  { href: "/docs", label: "Docs", icon: DocsIcon },
] as const;

/** "/" also owns token pages, so Explore stays lit while inspecting a market. */
function useIsCurrent(): (href: string) => boolean {
  const pathname = usePathname();
  return (href: string) => {
    if (href === "/") return pathname === "/" || pathname.startsWith("/tokens");
    return pathname === href || pathname.startsWith(`${href}/`);
  };
}

export function TopNav() {
  const isCurrent = useIsCurrent();
  return (
    <nav className="topnav" aria-label="Primary">
      {DESTINATIONS.map((d) => (
        <Link key={d.href} href={d.href} aria-current={isCurrent(d.href) ? "page" : undefined}>
          {d.label}
        </Link>
      ))}
    </nav>
  );
}

/**
 * The primary action, as a button rather than a link.
 *
 * Sits in the topbar beside the wallet, where the eye already goes for the
 * things you *do* rather than the places you go.
 */
export function LaunchButton() {
  return (
    <Link href={LAUNCH.href} className="btn btn-primary nav-launch">
      {LAUNCH.label}
    </Link>
  );
}

/** Mobile only (CSS-gated). Docs is dropped here — five targets is too many for
 *  a thumb bar, and Docs is the least urgent on a phone. Launch is folded back
 *  in as a peer, since a phone has no room for a separate button. */
export function BottomNav() {
  const isCurrent = useIsCurrent();
  const items = [...DESTINATIONS.filter((d) => d.href !== "/docs"), LAUNCH];
  return (
    <nav className="botnav" aria-label="Primary (mobile)">
      {items.map((d) => {
        const Icon = d.icon;
        return (
          <Link key={d.href} href={d.href} aria-current={isCurrent(d.href) ? "page" : undefined}>
            <Icon />
            {d.label}
          </Link>
        );
      })}
    </nav>
  );
}

const S = {
  width: 19,
  height: 19,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.7,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true as const,
};

function ExploreIcon() {
  return (
    <svg {...S}>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.6-3.6" />
    </svg>
  );
}
function LaunchIcon() {
  return (
    <svg {...S}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}
function PortfolioIcon() {
  return (
    <svg {...S}>
      <path d="M4 19V10M9.33 19V5M14.67 19v-7M20 19v-4" />
    </svg>
  );
}
function ActivityIcon() {
  return (
    <svg {...S}>
      <path d="M3 12h4l2.5-7 5 14L17 12h4" />
    </svg>
  );
}
function DocsIcon() {
  return (
    <svg {...S}>
      <path d="M6 4h8l4.5 4.5V20H6z" />
      <path d="M14 4v5h4.5" />
    </svg>
  );
}
