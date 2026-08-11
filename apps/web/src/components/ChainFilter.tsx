import Link from "next/link";
import { CHAINS, type ChainKey, type LaunchChain } from "@/lib/chains";
import { ChainMark } from "@/components/ChainMark";

export interface ChainFilterStatus {
  readonly key: ChainKey;
  /** No RPC answered — the chain is shown greyed with a dot. */
  readonly unreachable: boolean;
  readonly count: number;
}

/**
 * Chain filter for the launch list: All · Arc · Robinhood · BNB.
 *
 * A chain that can't be reached right now is greyed and marked rather than
 * removed — its tokens still exist and still show (from snapshot), so hiding
 * the chain would be a lie. Selection lives in the URL so the list stays
 * linkable and server-rendered.
 */
export function ChainFilter({
  active,
  statuses,
  basePath = "/tokens",
  params,
}: {
  readonly active: ChainKey | "all";
  readonly statuses: readonly ChainFilterStatus[];
  readonly basePath?: string;
  readonly params?: Readonly<Record<string, string>>;
}) {
  const byKey = new Map(statuses.map((s) => [s.key, s]));
  const shown = CHAINS.filter((c) => c.factories.length > 0);
  const total = statuses.reduce((n, s) => n + s.count, 0);

  function href(key: ChainKey | "all"): string {
    const q = new URLSearchParams(params ?? {});
    if (key === "all") q.delete("chain");
    else q.set("chain", key);
    const s = q.toString();
    return s === "" ? basePath : `${basePath}?${s}`;
  }

  return (
    <div className="arch-chain-filter" role="group" aria-label="Filter by chain">
      <Link
        href={href("all")}
        className={active === "all" ? "arch-chain-tab arch-chain-tab-active" : "arch-chain-tab"}
        aria-current={active === "all" ? "true" : undefined}
      >
        <span className="arch-chain-tab-marks" aria-hidden>
          {shown.map((c) => (
            <ChainMark key={c.key} chain={c} size={14} />
          ))}
        </span>
        All
        {total > 0 ? <span className="arch-chain-tab-count">{total}</span> : null}
      </Link>

      {shown.map((c: LaunchChain) => {
        const s = byKey.get(c.key);
        const down = s?.unreachable === true;
        return (
          <Link
            key={c.key}
            href={href(c.key)}
            title={down ? `${c.name} is unreachable right now — tokens are safe on-chain` : c.name}
            aria-current={active === c.key ? "true" : undefined}
            className={[
              "arch-chain-tab",
              active === c.key ? "arch-chain-tab-active" : "",
              down ? "arch-chain-tab-down" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            style={{ ["--chain-accent" as string]: c.accent }}
          >
            <ChainMark chain={c} size={15} />
            {c.shortName}
            {down ? <span className="arch-chain-tab-dot" aria-label="unreachable" /> : null}
            {!down && s !== undefined && s.count > 0 ? (
              <span className="arch-chain-tab-count">{s.count}</span>
            ) : null}
          </Link>
        );
      })}
    </div>
  );
}
