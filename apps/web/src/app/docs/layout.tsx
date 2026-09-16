import type { ReactNode } from "react";
import { DocsNav } from "./DocsNav";

export const metadata = { title: "Documentation — Arcanium" };

/** Left-sidebar docs shell: section list on the left, content on the right. */
export default function DocsLayout({ children }: { readonly children: ReactNode }) {
  return (
    <div className="docs-shell">
      <aside className="docs-sidebar">
        <DocsNav />
      </aside>
      <article className="docs-content">{children}</article>
    </div>
  );
}
