import path from "node:path";

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Without this Next infers the workspace root from whichever lockfile it
  // finds first, which on this machine is a stray package-lock.json in the
  // home directory — so file tracing walked the wrong tree entirely.
  outputFileTracingRoot: path.join(import.meta.dirname, "../../"),
  transpilePackages: ["@arch/ui"],
  webpack: (config) => {
    // @coinbase/cdp-sdk (pulled in transitively by wagmi's connector set)
    // references optional @x402/* entrypoints that are not published; Arch
    // never calls those code paths.
    config.resolve.alias = {
      ...config.resolve.alias,
      "@x402/evm/upto/client": false,
      "@x402/evm/exact/client": false,
      "@x402/core/client": false,
      "@x402/svm/exact/client": false,
      "@x402/evm": false,
      "@x402/svm": false,
      "@x402/core": false,
    };
    return config;
  },
};

export default nextConfig;
