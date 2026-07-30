/** Shimmer skeletons matching each page's real layout, so navigation paints
 *  instantly and loading reads as motion instead of delay. */

export function Sk({ h, w, r = 10, style }: { readonly h: number; readonly w?: number | string; readonly r?: number; readonly style?: React.CSSProperties }) {
  return <span className="arch-skeleton" style={{ display: "block", height: h, width: w ?? "100%", borderRadius: r, ...style }} />;
}

export function TokenCardSkeleton() {
  return (
    <div className="arch-token-card" aria-hidden>
      <div style={{ display: "flex", alignItems: "center", gap: "0.7rem" }}>
        <Sk h={44} w={44} r={12} />
        <div style={{ flex: 1, display: "grid", gap: 6 }}>
          <Sk h={14} w="45%" />
          <Sk h={11} w="70%" />
        </div>
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", gap: "0.5rem" }}>
        <div style={{ display: "grid", gap: 6, flex: 1 }}><Sk h={10} w="50%" /><Sk h={14} w="70%" /></div>
        <div style={{ display: "grid", gap: 6, flex: 1, justifyItems: "end" }}><Sk h={10} w="55%" /><Sk h={14} w="65%" /></div>
      </div>
      <Sk h={6} r={999} />
    </div>
  );
}

export function TokenGridSkeleton({ count = 6 }: { readonly count?: number }) {
  return (
    <div className="arch-token-grid" aria-hidden>
      {Array.from({ length: count }, (_, i) => <TokenCardSkeleton key={i} />)}
    </div>
  );
}

export function StatStripSkeleton() {
  return (
    <div className="arch-stat-bar" aria-hidden>
      {[0, 1, 2, 3, 4].map((i) => (
        <div key={i} style={{ display: "grid", gap: 8 }}>
          <Sk h={10} w="60%" />
          <Sk h={20} w="40%" />
        </div>
      ))}
    </div>
  );
}

export function TerminalSkeleton() {
  return (
    <div className="arch-terminal" aria-hidden>
      <section className="arch-card" style={{ display: "grid", gap: 12 }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
          <Sk h={30} w={220} r={999} />
          <Sk h={16} w={180} />
        </div>
        <Sk h={380} r={14} />
      </section>
      <div className="arch-stack">
        <section className="arch-card" style={{ display: "grid", gap: 10 }}>
          <Sk h={16} w="30%" />
          <Sk h={110} r={14} />
          <Sk h={46} r={12} />
        </section>
        <section className="arch-card" style={{ display: "grid", gap: 10 }}>
          <Sk h={16} w="35%" />
          {[0, 1, 2, 3].map((i) => (
            <div key={i} style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
              <Sk h={12} w="40%" /><Sk h={12} w="30%" />
            </div>
          ))}
        </section>
      </div>
    </div>
  );
}
