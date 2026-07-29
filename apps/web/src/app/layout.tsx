import type { Metadata } from "next";
import { Inter } from "next/font/google";
import Link from "next/link";
import Image from "next/image";
import "./globals.css";
import { Providers } from "./providers";
import { NetworkPill, WalletButton } from "@/components/WalletButton";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });

export const metadata: Metadata = {
  title: "Arcanium — Bridge and launch on Arc",
  description:
    "Bridge USDC to Arc. Launch a token. Trade immediately through permanently locked Uniswap liquidity.",
};

const NAV = [
  { href: "/", label: "Bridge" },
  { href: "/tokens", label: "Launchpad" },
  { href: "/create", label: "Create" },
  { href: "/gas", label: "Gas" },
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
              <NetworkPill />
              <WalletButton />
            </div>
          </header>
          <main>{children}</main>
        </Providers>
      </body>
    </html>
  );
}
