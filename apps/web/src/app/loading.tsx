import { Sk, StatStripSkeleton, TokenGridSkeleton } from "@/components/Skeletons";

export default function HomeLoading() {
  return (
    <div>
      <div className="arch-hero" aria-hidden>
        <Sk h={48} w="min(560px, 90%)" style={{ margin: "0 auto" }} />
        <Sk h={48} w="min(420px, 70%)" style={{ margin: "0.6rem auto 0" }} />
        <Sk h={14} w="min(460px, 80%)" style={{ margin: "1.2rem auto 0" }} />
        <div style={{ display: "flex", gap: "0.75rem", justifyContent: "center", marginTop: "1.6rem" }}>
          <Sk h={48} w={170} r={12} />
          <Sk h={48} w={150} r={12} />
        </div>
      </div>
      <div className="arch-stack">
        <StatStripSkeleton />
        <TokenGridSkeleton />
      </div>
    </div>
  );
}
