import { Sk, TokenGridSkeleton } from "@/components/Skeletons";

export default function TokensLoading() {
  return (
    <div className="arch-stack">
      <div style={{ display: "grid", gap: 8 }}>
        <Sk h={26} w={200} />
        <Sk h={13} w="min(480px, 85%)" />
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <Sk h={38} w={340} r={999} />
        <Sk h={38} w={260} r={12} />
      </div>
      <TokenGridSkeleton count={9} />
    </div>
  );
}
