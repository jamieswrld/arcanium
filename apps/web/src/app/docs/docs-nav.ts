/** Docs navigation: sections with nested pages. Slug "" is the overview. */
export interface DocLink {
  readonly slug: string; // path after /docs (e.g. "bridge/fees"); "" = overview
  readonly title: string;
}
export interface DocSection {
  readonly title: string;
  readonly links: readonly DocLink[];
}

export const DOCS_NAV: readonly DocSection[] = [
  { title: "Overview", links: [{ slug: "", title: "Introduction" }] },
  {
    title: "Get started",
    links: [
      { slug: "start/connect", title: "Connect a wallet" },
      { slug: "start/networks", title: "Add Base and Arc" },
      { slug: "start/get-usdc", title: "Getting USDC on Base" },
    ],
  },
  {
    title: "Bridge",
    links: [
      { slug: "bridge", title: "How the bridge works" },
      { slug: "bridge/fees", title: "Fees, finality and safety" },
      { slug: "bridge/sell", title: "Selling aUSD back to USDC" },
      { slug: "bridge/wind-down", title: "Switching to native USDC" },
    ],
  },
  {
    title: "Launchpad",
    links: [
      { slug: "launchpad", title: "Launching a token" },
      { slug: "launchpad/economics", title: "Pricing, graduation and fees" },
      { slug: "launchpad/trading", title: "Buying and selling" },
    ],
  },
  {
    title: "Gas",
    links: [{ slug: "gas", title: "Sponsored Arc gas" }],
  },
  {
    title: "Reference",
    links: [
      { slug: "reference/addresses", title: "Contract addresses" },
      { slug: "reference/security", title: "Security and risks" },
    ],
  },
];

export const ALL_SLUGS: readonly string[] = DOCS_NAV.flatMap((s) => s.links.map((l) => l.slug));

export function findDoc(slug: string): { section: string; title: string } | null {
  for (const section of DOCS_NAV) {
    for (const link of section.links) {
      if (link.slug === slug) return { section: section.title, title: link.title };
    }
  }
  return null;
}
