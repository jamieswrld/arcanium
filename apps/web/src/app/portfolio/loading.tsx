import { Sk } from "@/components/Skeletons";

export default function PortfolioLoading() {
  return (
    <div className="arch-stack">
      <section className="arch-card" aria-hidden>
        <div style={{ display: "flex", gap: "1rem", alignItems: "center" }}>
          <Sk h={56} w={56} r={14} />
          <div style={{ display: "grid", gap: 8 }}>
            <Sk h={11} w={120} />
            <Sk h={24} w={160} />
          </div>
        </div>
      </section>
      <section className="arch-card" aria-hidden style={{ display: "grid", gap: 10 }}>
        <Sk h={14} w="25%" />
        {[0, 1].map((i) => (
          <div key={i} style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
            <Sk h={13} w="30%" /><Sk h={13} w="20%" /><Sk h={13} w="15%" />
          </div>
        ))}
      </section>
    </div>
  );
}
