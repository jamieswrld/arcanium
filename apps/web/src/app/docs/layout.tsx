import Link from "next/link";
import type { ReactNode } from "react";
import { DOCS_NAV } from "./docs-nav";

export const metadata = { title: "Documentation — Arcanium" };

/** Left-sidebar docs shell: section list on the left, content on the right. */
export default function DocsLayout({ children }: { readonly children: ReactNode }) {
  return (
    <div className="docs-shell">
      <aside className="docs-sidebar">
        <nav aria-label="Documentation">
          {DOCS_NAV.map((section) => (
            <div key={section.title} className="docs-nav-section">
              <div className="docs-nav-heading">{section.title}</div>
              {section.links.map((link) => (
                <Link key={link.slug} href={link.slug === "" ? "/docs" : `/docs/${link.slug}`} className="docs-nav-link">
                  {link.title}
                </Link>
              ))}
            </div>
          ))}
        </nav>
      </aside>
      <article className="docs-content">{children}</article>
    </div>
  );
}
