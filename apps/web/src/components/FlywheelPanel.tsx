"use client";

import { useEffect, useState } from "react";

/**
 * What the flywheel has bought and burned, on the ARCANIUM page only.
 *
 * Deliberately scoped to this one token. The buyback exists to buy ARCANIUM
 * specifically, so showing it against any other market would imply a mechanism
 * that token does not have.
 *
 * The two figures are kept apart on purpose. "Bought" is protocol fees spent;
 * "burned" is tokens destroyed by that spending. Neither is the token's total
 * supply reduction — the token side of every trading fee is also burned, and
 * so is the launch's rounding dust — and the copy says so rather than letting
 * the larger number be assumed.
 */

interface Flywheel {
  readonly spentUsd: { units: string; decimals: number };
  readonly burnedTokens: { units: string; decimals: number };
  readonly burns: number;
  readonly waiting: { units: string; decimals: number };
}

function fmtUsd(units: string): string {
  try {
    const v = BigInt(units);
    const whole = v / 1_000_000n;
    const cents = (v % 1_000_000n).toString().padStart(6, "0").slice(0, 2);
    return `$${whole.toLocaleString("en-US")}.${cents}`;
  } catch {
    return "—";
  }
}

function fmtTokens(units: string): string {
  try {
    const whole = BigInt(units) / 10n ** 18n;
    return whole.toLocaleString("en-US");
  } catch {
    return "—";
  }
}

export function FlywheelPanel() {
  const [data, setData] = useState<Flywheel | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const tick = async (): Promise<void> => {
      try {
        const res = await fetch("/api/flywheel", { cache: "no-store" });
        const body = (await res.json()) as { data?: Flywheel };
        if (cancelled) return;
        if (!res.ok || body.data === undefined) setFailed(true);
        else {
          setData(body.data);
          setFailed(false);
        }
      } catch {
        if (!cancelled) setFailed(true);
      }
    };
    void tick();
    const t = setInterval(() => void tick(), 60_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  // Nothing is claimed while the figures are unknown. An outage must not read
  // as "the flywheel has burned nothing".
  if (data === null) {
    return failed ? (
      <section className="arch-card">
        <div className="arch-stat-label">Buy &amp; burn</div>
        <p className="arch-note" style={{ margin: "0.3rem 0 0" }}>
          Could not read the buyback contract just now. This is not a statement that nothing has
          been burned — reload in a moment.
        </p>
      </section>
    ) : null;
  }

  const never = data.burns === 0;

  return (
    <section
      className="arch-card"
      style={{ borderColor: "color-mix(in oklch, var(--primary) 30%, var(--border))" }}
    >
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: "0.75rem", flexWrap: "wrap" }}>
        <div style={{ fontWeight: 700 }}>Buy &amp; burn</div>
        <span className="arch-note" style={{ fontSize: "0.72rem" }}>
          {data.burns.toLocaleString("en-US")} {data.burns === 1 ? "burn" : "burns"} · hourly
        </span>
      </div>

      <p className="arch-note" style={{ margin: "0.3rem 0 0.9rem" }}>
        A tenth of every protocol fee buys ARCANIUM on this market and sends it to{" "}
        <span className="mono">0xdead</span>. The contract holding it has no owner and no way to
        withdraw — the only exit is the burn.
      </p>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: "0.85rem" }}>
        <div>
          <div className="arch-stat-label">Bought</div>
          <div className="num" style={{ fontSize: "1.25rem", fontWeight: 700 }}>
            {fmtUsd(data.spentUsd.units)}
          </div>
        </div>
        <div>
          <div className="arch-stat-label">Burned</div>
          <div className="num" style={{ fontSize: "1.25rem", fontWeight: 700 }}>
            {fmtTokens(data.burnedTokens.units)}
          </div>
        </div>
        <div>
          <div className="arch-stat-label">Waiting</div>
          <div className="num" style={{ fontSize: "1.25rem", fontWeight: 700 }}>
            {fmtUsd(data.waiting.units)}
          </div>
        </div>
      </div>

      {never ? (
        <p className="arch-note" style={{ margin: "0.85rem 0 0", fontSize: "0.74rem" }}>
          Nothing burned yet. Fees have to accumulate past the minimum, and the market needs half an
          hour of price history before the contract will trade — it refuses rather than buy at a
          price somebody could have moved.
        </p>
      ) : (
        <p className="arch-note" style={{ margin: "0.85rem 0 0", fontSize: "0.74rem" }}>
          This counts only what the flywheel bought. The token side of every trade is burned too,
          so the total ever destroyed is higher than the figure above.
        </p>
      )}
    </section>
  );
}
