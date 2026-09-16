import Link from "next/link";

/**
 * The 404 page.
 *
 * There wasn't one, so every notFound() in the app fell through to Next's
 * default — which is both unbranded and, for the dynamic routes, was being
 * served with a 200. A page that says "this does not exist" while telling
 * every crawler it does is worse than either answer on its own: search engines
 * index unlimited nonsense URLs, and uptime checks cannot tell a broken route
 * from a missing one.
 */
export default function NotFound() {
  return (
    <div className="panel">
      <div className="empty">
        <h3>Nothing here</h3>
        <p className="arch-note" style={{ maxWidth: 380 }}>
          That page does not exist. It may have been renamed, or the link that brought you here may
          be out of date.
        </p>
        <div style={{ display: "flex", gap: "var(--s2)", marginTop: "var(--s3)", flexWrap: "wrap" }}>
          <Link href="/" className="btn btn-primary">
            Browse tokens
          </Link>
          <Link href="/docs" className="btn btn-secondary">
            Read the docs
          </Link>
        </div>
      </div>
    </div>
  );
}
