import { Sk, TerminalSkeleton } from "@/components/Skeletons";

export default function TokenLoading() {
  return (
    <div className="arch-stack" style={{ maxWidth: 1100, margin: "0 auto" }}>
      <section className="arch-card" aria-hidden>
        <div style={{ display: "flex", gap: "0.75rem", alignItems: "center" }}>
          <Sk h={52} w={52} r={14} />
          <div style={{ display: "grid", gap: 8, flex: 1 }}>
            <Sk h={16} w="30%" />
            <Sk h={11} w="45%" />
          </div>
          <Sk h={28} w={140} />
        </div>
        <div style={{ marginTop: "1rem" }}>
          <Sk h={6} r={999} />
        </div>
      </section>
      <TerminalSkeleton />
    </div>
  );
}
