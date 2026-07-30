import type { Metadata } from "next";
import { Inter } from "next/font/google";
import Link from "next/link";
import Image from "next/image";
import "./globals.css";
import { Providers } from "./providers";
import { WalletButton } from "@/components/WalletButton";
import { VersionGuard } from "@/components/VersionGuard";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });

export const metadata: Metadata = {
  title: "Arcanium — Launch tokens on Arc",
  description:
    "Launch a token on Arc paired with native USDC. Real Uniswap liquidity, permanently locked from block one.",
};

const NAV = [
  { href: "/", label: "Launchpad" },
  { href: "/create", label: "Create" },
  { href: "/portfolio", label: "Portfolio" },
  { href: "/docs", label: "Docs" },
];

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={inter.variable}>
      <body>
        <Providers>
          <header className="arch-header">
            <Link href="/" className="arch-logo" style={{ display: "flex", alignItems: "center", gap: "0.55rem" }}>
              <Image src="/arcanium-mark.png" alt="" width={34} height={27} priority />
              Arcanium
            </Link>
            <nav className="arch-nav" aria-label="Primary">
              {NAV.map((item) => (
                <Link key={item.href} href={item.href}>
                  {item.label}
                </Link>
              ))}
            </nav>
            <div className="arch-header-right">
              <a
                href="https://x.com/arcaniumtrade"
                target="_blank"
                rel="noreferrer"
                aria-label="Arcanium on X"
                title="@arcaniumtrade"
                style={{ display: "grid", placeItems: "center", width: 36, height: 36, borderRadius: 10, border: "1px solid var(--border)", background: "var(--card)", color: "var(--foreground)" }}
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                  <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
                </svg>
              </a>
              <WalletButton />
            </div>
          </header>
          <main>{children}</main>
          <VersionGuard />
        </Providers>
      </body>
    </html>
  );
}
