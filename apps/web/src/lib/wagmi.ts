import { createConfig, fallback, http } from "wagmi";
import { injected } from "wagmi/connectors";
import { arcTestnet } from "./bridgeClient";

/**
 * Wagmi config: Arc only. Arcanium is a pure Arc launchpad — tokens are created
 * and traded on Arc, paired with native Arc USDC. There is no Base/bridge step.
 * EIP-6963 multi-provider discovery surfaces every installed wallet; the
 * injected() connector is the fallback for wallets that don't announce.
 */
export const wagmiConfig = createConfig({
  chains: [arcTestnet],
  connectors: [injected({ shimDisconnect: true })],
  multiInjectedProviderDiscovery: true,
  transports: {
    // Reads go through our same-origin proxy (reliable in the browser), then
    // fall back to the direct RPC if the proxy itself is unreachable.
    [arcTestnet.id]: fallback([
      http("/api/arc-rpc", { timeout: 15_000 }),
      http(process.env["NEXT_PUBLIC_ARC_RPC_URL"] ?? "https://rpc.blockdaemon.mainnet.arc.io", { timeout: 15_000 }),
    ]),
  },
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
