import { createConfig, fallback, http } from "wagmi";
import { base, bsc } from "viem/chains";
import { defineChain } from "viem";
import { injected } from "wagmi/connectors";
import { arcTestnet } from "./bridgeClient";
import { arcTransport } from "./arcRpc";
import { chainTransport } from "./chainRpc";
import { getChain } from "./chains";

/**
 * Wagmi config: every chain Arcanium launches on (Arc, Robinhood, BNB) plus
 * Base, which exists solely so the CCTP bridge can approve + burn USDC there.
 * EIP-6963 discovery surfaces every installed wallet.
 */

const robinhoodCfg = getChain("robinhood");

/** Robinhood Chain — an Arbitrum Orbit L2 with ETH for gas. */
export const robinhoodChain = defineChain({
  id: robinhoodCfg.id,
  name: robinhoodCfg.name,
  nativeCurrency: robinhoodCfg.nativeCurrency,
  rpcUrls: { default: { http: [...robinhoodCfg.rpcUrls] } },
  blockExplorers: {
    default: { name: robinhoodCfg.explorer.name, url: robinhoodCfg.explorer.url },
  },
});

export const wagmiConfig = createConfig({
  chains: [arcTestnet, robinhoodChain, bsc, base],
  connectors: [injected({ shimDisconnect: true })],
  multiInjectedProviderDiscovery: true,
  transports: {
    // Direct to the RPC first (one hop, CORS-open), same-origin proxy fallback.
    [arcTestnet.id]: arcTransport({ browser: true }),
    [robinhoodChain.id]: chainTransport(robinhoodCfg, { browser: true }),
    [bsc.id]: chainTransport(getChain("bnb"), { browser: true }),
    [base.id]: fallback([
      http(process.env["NEXT_PUBLIC_BASE_RPC_URL"] ?? "https://mainnet.base.org", { timeout: 12_000 }),
      http("https://base.publicnode.com", { timeout: 12_000 }),
    ]),
  },
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
