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
      { slug: "start/networks", title: "Add the Arc network" },
      { slug: "start/get-usdc", title: "Getting USDC on Arc" },
    ],
  },
  {
    title: "Launchpad",
    links: [
      { slug: "launchpad", title: "Launching a token" },
      { slug: "launchpad/economics", title: "Pricing and graduation" },
      { slug: "launchpad/trading", title: "Buying and selling" },
    ],
  },
  {
    title: "Reference",
    links: [
      { slug: "reference/addresses", title: "Contract addresses" },
      { slug: "reference/integrators", title: "Terminals & integrators" },
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
