import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";
import { Providers } from "./providers";
import { NetworkPill, WalletButton } from "@/components/WalletButton";

export const metadata: Metadata = {
  title: "Arch — Bridge and launch on Arc",
  description:
    "Bridge USDC to Arc. Launch a token. Trade immediately through permanently locked Uniswap liquidity.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <Providers>
          <header className="arch-header">
            <Link href="/" className="arch-logo">
              Arch
            </Link>
            <nav className="arch-nav" aria-label="Primary">
              <Link href="/">Bridge</Link>
              <Link href="/tokens">Launchpad</Link>
              <Link href="/create">Create token</Link>
              <Link href="/gas">Gas</Link>
              <Link href="/portfolio">Portfolio</Link>
              <Link href="/docs">Documentation</Link>
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
