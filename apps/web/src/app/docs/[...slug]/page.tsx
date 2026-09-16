import { notFound } from "next/navigation";
import { DOCS } from "../docs-content";
import { ALL_SLUGS, findDoc } from "../docs-nav";

export function generateStaticParams(): { slug: string[] }[] {
  return ALL_SLUGS.filter((s) => s !== "").map((s) => ({ slug: s.split("/") }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string[] }> }) {
  const { slug } = await params;
  const doc = findDoc(slug.join("/"));
  if (doc === null) {
    // These routes are cached, so Next commits a 200 before notFound() lands.
    // Rather than disable caching for a status code, tell crawlers directly —
    // otherwise /docs/<anything> is an unlimited supply of indexable URLs.
    return { title: "Not found — Arcanium docs", robots: { index: false, follow: false } };
  }
  return { title: `${doc.title} — Arcanium docs` };
}

export default async function DocsPage({ params }: { params: Promise<{ slug: string[] }> }) {
  const { slug } = await params;
  const key = slug.join("/");
  const content = DOCS[key];
  if (content === undefined) notFound();
  return <>{content}</>;
}
