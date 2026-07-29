export interface StatRowProps {
  readonly label: string;
  readonly value: string;
  /** Set when the value is a placeholder awaiting live contract/API data. */
  readonly pending?: boolean;
}

/** Label/value row used in bridge and launch reviews — fees always visible. */
export function StatRow({ label, value, pending = false }: StatRowProps) {
  return (
    <div className="flex justify-between gap-4 py-1.5 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className={pending ? "text-muted-foreground" : "text-foreground font-medium"}>
        {value}
      </span>
    </div>
  );
}
