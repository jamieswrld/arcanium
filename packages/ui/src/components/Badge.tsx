export interface BadgeProps {
  readonly label: string;
  readonly tone?: "neutral" | "positive" | "negative" | "warning";
}

const toneClass: Record<NonNullable<BadgeProps["tone"]>, string> = {
  neutral: "text-muted-foreground border-muted-foreground/60",
  positive: "text-positive border-positive",
  negative: "text-negative border-negative",
  warning: "text-warning border-warning",
};

export function Badge({ label, tone = "neutral" }: BadgeProps) {
  return (
    <span
      className={`inline-block px-2.5 py-0.5 rounded-full border text-xs font-semibold ${toneClass[tone]}`}
    >
      {label}
    </span>
  );
}
