"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { DOCS_NAV } from "./docs-nav";

/**
 * Documentation sidebar.
 *
 * A client component purely so the current page can be marked. Without it the
 * sidebar was an undifferentiated list of every page in the docs, with nothing
 * indicating where you were — which is most of why they read as a wall.
 */
export function DocsNav() {
  const pathname = usePathname();

  return (
    <nav aria-label="Documentation">
      {DOCS_NAV.map((section) => (
        <div key={section.title} className="docs-nav-section">
          <div className="docs-nav-heading">{section.title}</div>
          {section.links.map((link) => {
            const href = link.slug === "" ? "/docs" : `/docs/${link.slug}`;
            return (
              <Link
                key={link.slug}
                href={href}
                className="docs-nav-link"
                aria-current={pathname === href ? "page" : undefined}
              >
                {link.title}
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
  );
}
