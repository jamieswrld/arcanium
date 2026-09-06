"use client";

import Link from "next/link";
import Image from "next/image";
import { usePathname } from "next/navigation";

/**
 * Product navigation.
 *
 * A rail rather than a top nav: the launchpad has real sections, and a rail
 * states the product's architecture while leaving the full width of the page to
 * the thing people came for — the launches. On narrow screens the same markup
 * becomes a bottom bar (see globals.css), so the primary workflow survives
 * instead of collapsing into a hamburger.
 *
 * Icons share one geometry: 18px box, 1.6 stroke, round caps, no fills.
 */

const NAV: readonly {
  readonly group: string;
  readonly items: readonly { readonly href: string; readonly label: string; readonly icon: React.ReactNode }[];
}[] = [
  {
    group: "Launchpad",
    items: [
      { href: "/", label: "Explore", icon: <ExploreIcon /> },
      { href: "/create", label: "Create", icon: <CreateIcon /> },
    ],
  },
  {
    group: "You",
    items: [
      { href: "/portfolio", label: "Portfolio", icon: <PortfolioIcon /> },
      { href: "/bridge", label: "Bridge", icon: <BridgeIcon /> },
    ],
  },
  {
    group: "More",
    items: [{ href: "/docs", label: "Docs", icon: <DocsIcon /> }],
  },
];

export function Rail() {
  const pathname = usePathname();

  /** "/" only matches exactly; everything else matches its subtree, so a token
   *  page keeps Explore lit. */
  function isCurrent(href: string): boolean {
    if (href === "/") return pathname === "/" || pathname.startsWith("/tokens");
    return pathname === href || pathname.startsWith(`${href}/`);
  }

  return (
    <nav className="arch-rail" aria-label="Primary">
      <Link href="/" className="arch-rail-brand">
        <Image src="/arcanium-mark.png" alt="" width={24} height={19} priority />
        Arcanium
      </Link>

      {NAV.map((section) => (
        <div key={section.group} style={{ display: "contents" }}>
          <div className="arch-rail-group">{section.group}</div>
          {section.items.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="arch-rail-link"
              aria-current={isCurrent(item.href) ? "page" : undefined}
            >
              {item.icon}
              {item.label}
            </Link>
          ))}
        </div>
      ))}

      <div className="arch-rail-foot">
        Non-custodial. Your wallet signs every transaction — Arcanium never holds
        your assets or your keys.
      </div>
    </nav>
  );
}

const S = {
  width: 18,
  height: 18,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.6,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true as const,
};

function ExploreIcon() {
  return (
    <svg {...S}>
      <circle cx="11" cy="11" r="7.25" />
      <path d="m20 20-3.7-3.7" />
    </svg>
  );
}

function CreateIcon() {
  return (
    <svg {...S}>
      <path d="M12 4.5v15M4.5 12h15" />
    </svg>
  );
}

function PortfolioIcon() {
  return (
    <svg {...S}>
      <path d="M4 19V9.5M9.33 19V5M14.67 19v-6.5M20 19v-9" />
    </svg>
  );
}

function BridgeIcon() {
  return (
    <svg {...S}>
      <path d="M3 16.5c3 0 3-9 9-9s6 9 9 9" />
      <path d="M3 19.5h18" />
    </svg>
  );
}

function DocsIcon() {
  return (
    <svg {...S}>
      <path d="M6 4.5h8L18.5 9v10.5H6z" />
      <path d="M13.5 4.5V9.5H18.5" />
    </svg>
  );
}
