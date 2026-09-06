import { Sk } from "@/components/Skeletons";

/**
 * Explore skeleton.
 *
 * Mirrors the real layout — left-aligned header, stat strip, control rail, then
 * the market table beside ARC PULSE — so the page does not visibly rearrange
 * when data lands. The previous version still described the old centred hero and
 * card grid, so the loading state and the page it preceded were different
 * layouts, which reads as a jump.
 */
export default function ExploreLoading() {
  return (
    <div className="stack" aria-hidden>
      <header className="spread" style={{ alignItems: "flex-end", flexWrap: "wrap", gap: "var(--s4)" }}>
        <div style={{ minWidth: 0 }}>
          <Sk h={30} w="min(320px, 70vw)" />
          <Sk h={13} w="min(460px, 88vw)" style={{ marginTop: 10 }} />
        </div>
        <div className="row" style={{ flexShrink: 0 }}>
          <Sk h={36} w={124} r={7} />
          <Sk h={36} w={158} r={7} />
        </div>
      </header>

      <div className="arch-stat-bar">
        {Array.from({ length: 5 }, (_, i) => (
          <div key={i}>
            <Sk h={10} w={72} />
            <Sk h={19} w={58} style={{ marginTop: 8 }} />
          </div>
        ))}
      </div>

      <div className="spread" style={{ flexWrap: "wrap", gap: "var(--s3)" }}>
        <Sk h={32} w="min(430px, 82vw)" r={7} />
        <Sk h={36} w={220} r={7} />
      </div>

      <div className="explore-grid">
        <div className="panel" style={{ minWidth: 0 }}>
          {/* Header row, then eight market rows at the real row height. */}
          <div style={{ padding: "10px 16px", borderBottom: "1px solid var(--border)" }}>
            <Sk h={10} w={150} />
          </div>
          {Array.from({ length: 8 }, (_, i) => (
            <div
              key={i}
              className="spread"
              style={{ padding: "10px 16px", borderBottom: "1px solid var(--border)", gap: "var(--s3)" }}
            >
              <div className="row" style={{ minWidth: 0 }}>
                <Sk h={30} w={30} r={7} />
                <div>
                  <Sk h={12} w={62} />
                  <Sk h={10} w={92} style={{ marginTop: 5 }} />
                </div>
              </div>
              <Sk h={12} w={72} />
            </div>
          ))}
        </div>

        <div className="panel" style={{ minWidth: 0 }}>
          <div style={{ padding: "14px 16px", borderBottom: "1px solid var(--border)" }}>
            <Sk h={10} w={78} />
          </div>
          {Array.from({ length: 6 }, (_, i) => (
            <div
              key={i}
              className="spread"
              style={{ padding: "8px 16px", borderBottom: "1px solid var(--border)", gap: "var(--s2)" }}
            >
              <Sk h={10} w={34} />
              <Sk h={10} w={84} />
              <Sk h={10} w={24} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
