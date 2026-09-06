import type { Metadata } from "next";
import { Suspense } from "react";
import { Inter, Space_Grotesk, JetBrains_Mono } from "next/font/google";
import Link from "next/link";
import "./globals.css";
import { Providers } from "./providers";
import { WalletButton } from "@/components/WalletButton";
import { VersionGuard } from "@/components/VersionGuard";
import { SearchCommand } from "@/components/SearchCommand";
import { Rail } from "@/components/Rail";

/**
 * Three typefaces, each with a job:
 *   Inter          — UI text, with tabular numerals so money columns align.
 *   Space Grotesk  — display. Gives headings and the wordmark a voice that is
 *                    ours rather than the default system stack.
 *   JetBrains Mono — addresses and hashes, where character disambiguation
 *                    genuinely matters.
 */
const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });
const display = Space_Grotesk({ subsets: ["latin"], variable: "--font-display", display: "swap" });
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-mono", display: "swap" });

export const viewport = {
  themeColor: "#191527",
  width: "device-width",
  initialScale: 1,
};

export const metadata: Metadata = {
  title: "Arcanium — Launch tokens on Arc",
  description:
    "Launch a token on Arc paired with native USDC. Real Uniswap liquidity, permanently locked from block one.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${inter.variable} ${display.variable} ${mono.variable}`}>
      <head>
        <link rel="preconnect" href="https://rpc.arc-scan.org" crossOrigin="anonymous" />
      </head>
      <body>
        <Providers>
          <div className="arch-shell">
            <Rail />

            <div style={{ minWidth: 0, display: "flex", flexDirection: "column" }}>
              <header className="arch-topbar">
                <Suspense fallback={null}>
                  <SearchCommand />
                </Suspense>

                <div className="arch-header-right">
                  <span className="arch-network-pill" title="Arcanium launches on Arc (chain 5042)">
                    <span
                      aria-hidden
                      style={{
                        width: 6,
                        height: 6,
                        borderRadius: 999,
                        background: "var(--positive)",
                        boxShadow: "0 0 0 3px var(--positive-quiet)",
                      }}
                    />
                    Arc
                  </span>
                  <a
                    href="https://x.com/arcaniumtrade"
                    target="_blank"
                    rel="noreferrer"
                    aria-label="Arcanium on X"
                    title="@arcaniumtrade"
                    style={{
                      display: "grid",
                      placeItems: "center",
                      width: 36,
                      height: 36,
                      borderRadius: "var(--r-md)",
                      border: "1px solid var(--line-strong)",
                      background: "var(--surface)",
                      color: "var(--text-muted)",
                    }}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
                    </svg>
                  </a>
                  <Link href="/create" className="arch-primary-button" style={{ height: 36, padding: "0 14px" }}>
                    Launch
                  </Link>
                  <WalletButton />
                </div>
              </header>

              <main className="arch-main">{children}</main>

              <footer className="arch-footer">
                <div
                  style={{
                    display: "flex",
                    justifyContent: "center",
                    gap: "1.1rem",
                    flexWrap: "wrap",
                    marginBottom: "0.7rem",
                  }}
                >
                  <Link href="/">Explore</Link>
                  <Link href="/create">Create</Link>
                  <Link href="/portfolio">Portfolio</Link>
                  <Link href="/docs">Docs</Link>
                  <a href="https://x.com/arcaniumtrade" target="_blank" rel="noreferrer">
                    X
                  </a>
                </div>
                <p style={{ margin: 0, maxWidth: 620, marginInline: "auto", lineHeight: 1.55 }}>
                  Arcanium is a permissionless launchpad on Arc. Liquidity is locked at launch and
                  can never be withdrawn — by anyone, including us. Tokens are volatile and can lose
                  value. Nothing here is financial advice.
                </p>
              </footer>
            </div>
          </div>
          <VersionGuard />
        </Providers>
      </body>
    </html>
  );
}
