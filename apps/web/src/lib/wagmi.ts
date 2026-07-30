import { createConfig, fallback, http } from "wagmi";
import { base } from "viem/chains";
import { injected } from "wagmi/connectors";
import { arcTestnet } from "./bridgeClient";
import { arcTransport } from "./arcRpc";

/**
 * Wagmi config: Arc (home chain) + Base (bridge source). The launchpad lives
 * entirely on Arc; Base exists solely so the CCTP bridge can approve + burn
 * USDC there. EIP-6963 discovery surfaces every installed wallet.
 */
export const wagmiConfig = createConfig({
  chains: [arcTestnet, base],
  connectors: [injected({ shimDisconnect: true })],
  multiInjectedProviderDiscovery: true,
  transports: {
    // Direct to the RPC first (one hop, CORS-open), same-origin proxy fallback.
    [arcTestnet.id]: arcTransport({ browser: true }),
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
