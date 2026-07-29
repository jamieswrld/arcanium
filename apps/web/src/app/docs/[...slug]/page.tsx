import { notFound } from "next/navigation";
import { DOCS } from "../docs-content";
import { ALL_SLUGS, findDoc } from "../docs-nav";

export function generateStaticParams(): { slug: string[] }[] {
  return ALL_SLUGS.filter((s) => s !== "").map((s) => ({ slug: s.split("/") }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string[] }> }) {
  const { slug } = await params;
  const doc = findDoc(slug.join("/"));
  return { title: doc ? `${doc.title} — Arcanium docs` : "Documentation — Arcanium" };
}

export default async function DocsPage({ params }: { params: Promise<{ slug: string[] }> }) {
  const { slug } = await params;
  const key = slug.join("/");
  const content = DOCS[key];
  if (content === undefined) notFound();
  return <>{content}</>;
}
