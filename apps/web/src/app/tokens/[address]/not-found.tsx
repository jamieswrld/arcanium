import Link from "next/link";

/**
 * Not an Arcanium market.
 *
 * Scoped to this route so the page can keep its specific explanation — "that
 * address exists, it just wasn't launched here" is a different and more useful
 * thing to say than "no such page" — while still being served with a 404
 * rather than a 200. Previously this copy was rendered inline from the page
 * component, which meant an unknown address returned a success status and got
 * indexed.
 */
export default function TokenNotFound() {
  return (
    <div className="panel">
      <div className="empty">
        <h3>Not an Arcanium market</h3>
        <p className="arch-note" style={{ maxWidth: 380 }}>
          That address was not launched through Arcanium, so there is no locked-liquidity market for
          it here. It may still be a real token elsewhere on Arc.
        </p>
        <Link href="/" className="btn btn-primary" style={{ marginTop: "var(--s2)" }}>
          Browse tokens
        </Link>
      </div>
    </div>
  );
}
