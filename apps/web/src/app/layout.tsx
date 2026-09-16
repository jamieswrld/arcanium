import type { Metadata } from "next";
import { Suspense } from "react";
import { Archivo, IBM_Plex_Sans, IBM_Plex_Mono } from "next/font/google";
import Link from "next/link";
import Image from "next/image";
import "./globals.css";
import { Providers } from "./providers";
import { WalletButton } from "@/components/WalletButton";
import { VersionGuard } from "@/components/VersionGuard";
import { SearchCommand } from "@/components/SearchCommand";
import { TopNav, BottomNav, LaunchButton, ArcaniumTokenLink } from "@/components/Nav";
import { NetworkBadge } from "@/components/NetworkBadge";

/**
 * Typography — three faces, each with a job.
 *
 *   Archivo        display. A tight industrial grotesque; carries the wordmark
 *                  and headings with more character than a system stack.
 *   IBM Plex Sans  body and market data. Built for technical interfaces and
 *                  stays legible at the small sizes a dense table demands.
 *   IBM Plex Mono  addresses, hashes and tx ids, where telling 0 from O matters.
 *
 * All three ship real tabular figures, which is what keeps price columns
 * aligned rather than merely close.
 */
const display = Archivo({
  subsets: ["latin"],
  variable: "--font-display",
  display: "swap",
  weight: ["500", "600", "700"],
});
const body = IBM_Plex_Sans({
  subsets: ["latin"],
  variable: "--font-body",
  display: "swap",
  weight: ["400", "500", "600"],
});
const mono = IBM_Plex_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
  display: "swap",
  weight: ["400", "500"],
});

export const viewport = {
  themeColor: "#1c1b20",
  width: "device-width",
  initialScale: 1,
};

export const metadata: Metadata = {
  // Required for relative OG image URLs to resolve. Without it Next emits a
  // relative path and every crawler ignores the image.
  metadataBase: new URL("https://arcanium.trade"),
  title: {
    default: "Arcanium — Markets begin here",
    template: "%s — Arcanium",
  },
  description:
    "Launch and trade permanently locked markets on Arc. Fixed supply, real Uniswap liquidity, locked from block one.",
  applicationName: "Arcanium",
  // There were no social tags at all, so a link posted anywhere rendered as a
  // bare URL. The images themselves are generated per route.
  openGraph: {
    type: "website",
    siteName: "Arcanium",
    url: "https://arcanium.trade",
    title: "Arcanium — Markets begin here",
    description:
      "Launch a token on Arc with real Uniswap liquidity, locked from the first block.",
  },
  twitter: {
    card: "summary_large_image",
    site: "@arcaniumtrade",
    creator: "@arcaniumtrade",
    title: "Arcanium — Markets begin here",
    description:
      "Launch a token on Arc with real Uniswap liquidity, locked from the first block.",
  },
  icons: { icon: "/icon.png", apple: "/apple-icon.png" },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${display.variable} ${body.variable} ${mono.variable}`}>
      <head>
        <link rel="preconnect" href="https://rpc.quicknode.mainnet.arc.io" crossOrigin="anonymous" />
      </head>
      <body>
        <Providers>
          <div className="app">
            <header className="topbar">
              <Link href="/" className="brand">
                <Image src="/arcanium-mark.png" alt="" width={22} height={17} priority />
                Arcanium
              </Link>

              <TopNav />

              <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: "var(--s2)", minWidth: 0 }}>
                <Suspense fallback={null}>
                  <SearchCommand />
                </Suspense>
                <ArcaniumTokenLink />
                <NetworkBadge />
                <LaunchButton />
                <WalletButton />
              </div>
            </header>

            <main className="main">{children}</main>

            <footer className="footer">
              <div
                style={{
                  display: "flex",
                  justifyContent: "center",
                  gap: "var(--s4)",
                  flexWrap: "wrap",
                  marginBottom: "var(--s3)",
                }}
              >
                <Link href="/">Explore</Link>
                <Link href="/create">Launch</Link>
                <Link href="/locked">Lock</Link>
                <Link href="/portfolio">Portfolio</Link>
                <Link href="/activity">Activity</Link>
                <Link href="/stats">Stats</Link>
                <Link href="/bridge">Bridge</Link>
                <Link href="/docs">Docs</Link>
                <a href="https://x.com/arcaniumtrade" target="_blank" rel="noreferrer">
                  X
                </a>
              </div>
              <p style={{ margin: 0, maxWidth: 640, marginInline: "auto", lineHeight: 1.6 }}>
                Non-custodial: your wallet signs every transaction and Arcanium never holds your
                assets or keys. Launch liquidity is locked permanently and cannot be withdrawn by
                anyone, including us. Graduation is a milestone label — it is not a guarantee of
                quality or price. Tokens are volatile and can lose value.
              </p>
            </footer>

            <BottomNav />
          </div>
          <VersionGuard />
        </Providers>
      </body>
    </html>
  );
}
