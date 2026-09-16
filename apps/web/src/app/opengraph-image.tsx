import { ImageResponse } from "next/og";

/**
 * The card that appears when arcanium.trade is shared.
 *
 * There were no social tags at all before this, so a link posted anywhere
 * rendered as a bare URL. Drawn rather than served as a static file so it stays
 * in step with the brand tokens instead of becoming a PNG nobody updates.
 *
 * Deliberately plain: the wordmark, one line about what this is, and the chain.
 * A share card is read in half a second at thumbnail size, so anything more
 * than a name and a claim is lost.
 */

export const runtime = "edge";
export const alt = "Arcanium — launch and trade on Arc";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function Image() {
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
          // The app's own ground and accent, written literally: ImageResponse
          // has no access to CSS custom properties.
          background: "#141317",
          color: "#f4f3f6",
          fontFamily: "sans-serif",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
          <div
            style={{
              width: 56,
              height: 56,
              borderRadius: 14,
              background: "#8b7dff",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 34,
              fontWeight: 700,
              color: "#141317",
            }}
          >
            A
          </div>
          <div style={{ fontSize: 40, fontWeight: 700, letterSpacing: -1 }}>Arcanium</div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
          <div style={{ fontSize: 68, fontWeight: 700, letterSpacing: -2, lineHeight: 1.05 }}>
            Tokens begin here.
          </div>
          <div style={{ fontSize: 30, color: "#a8a5b3", maxWidth: 860, lineHeight: 1.35 }}>
            Launch a token on Arc with real Uniswap liquidity, locked from the first block.
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 14, fontSize: 24, color: "#6f6c7d" }}>
          <div
            style={{
              padding: "8px 16px",
              borderRadius: 999,
              border: "1px solid #2b2933",
              display: "flex",
            }}
          >
            Arc · chain 5042
          </div>
          <div style={{ display: "flex" }}>arcanium.trade</div>
        </div>
      </div>
    ),
    size,
  );
}
