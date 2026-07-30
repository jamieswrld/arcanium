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
