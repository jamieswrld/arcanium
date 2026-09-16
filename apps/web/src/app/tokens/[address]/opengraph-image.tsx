import { ImageResponse } from "next/og";
import { arcPublicClient, fetchToken, formatPriceE18, formatUsdCompact } from "@/lib/launchpad";
import { getChain } from "@/lib/chains";

/**
 * The card for a shared token link.
 *
 * A token link is the thing people actually post, so this carries the figures
 * somebody would want before deciding to click: symbol, price, market cap and
 * how close it is to graduating.
 *
 * Every number is read live. A card that renders a stale price is worse than
 * one with no price at all, because a screenshot of it outlives the moment —
 * so when the read fails the figure is omitted rather than guessed.
 */

export const alt = "Token on Arcanium";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const BG = "#141317";
const FG = "#f4f3f6";
const MUTED = "#a8a5b3";
const DIM = "#6f6c7d";
const ACCENT = "#8b7dff";
const LINE = "#2b2933";

export default async function Image({ params }: { params: Promise<{ address: string }> }) {
  const { address } = await params;
  const chain = getChain("arc");

  const token = /^0x[0-9a-fA-F]{40}$/.test(address)
    ? await fetchToken(arcPublicClient(), address as `0x${string}`).catch(() => null)
    : null;

  const symbol = token?.symbol ?? "Token";
  const name = token?.name ?? "on Arcanium";
  const price = token === null ? null : formatPriceE18(token.priceE18);
  const cap = token === null ? null : formatUsdCompact(token.marketCapUnits);
  const pct =
    token === null
      ? null
      : token.quoteBalance >= chain.graduationUnits
        ? 100
        : Number((token.quoteBalance * 100n) / chain.graduationUnits);

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: 72,
          background: BG,
          color: FG,
          fontFamily: "sans-serif",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
            <div
              style={{
                width: 40,
                height: 40,
                borderRadius: 10,
                background: ACCENT,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 24,
                fontWeight: 700,
                color: BG,
              }}
            >
              A
            </div>
            <div style={{ fontSize: 26, fontWeight: 600, color: MUTED }}>Arcanium</div>
          </div>
          {token?.graduated === true ? (
            <div
              style={{
                display: "flex",
                padding: "8px 18px",
                borderRadius: 999,
                border: `1px solid ${LINE}`,
                fontSize: 22,
                color: MUTED,
              }}
            >
              Graduated
            </div>
          ) : (
            <div style={{ display: "flex", fontSize: 22, color: DIM }}>Arc · chain 5042</div>
          )}
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ fontSize: 86, fontWeight: 700, letterSpacing: -3, lineHeight: 1 }}>
            {symbol}
          </div>
          <div style={{ fontSize: 30, color: MUTED }}>{name}</div>
        </div>

        <div style={{ display: "flex", gap: 56, alignItems: "flex-end" }}>
          {price === null ? null : (
            <Stat label="Price" value={price} />
          )}
          {cap === null ? null : <Stat label="Market cap" value={cap} />}
          {pct === null || token?.graduated === true ? null : (
            <Stat label="To graduation" value={`${pct}%`} />
          )}
          <div style={{ display: "flex", marginLeft: "auto", fontSize: 22, color: DIM }}>
            arcanium.trade
          </div>
        </div>
      </div>
    ),
    size,
  );
}

function Stat({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ fontSize: 20, color: DIM, textTransform: "uppercase", letterSpacing: 1 }}>
        {label}
      </div>
      <div style={{ fontSize: 44, fontWeight: 700 }}>{value}</div>
    </div>
  );
}
