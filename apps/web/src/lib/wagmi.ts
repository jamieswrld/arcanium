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
    [arcTestnet.id]: fallback([
      http(process.env["NEXT_PUBLIC_ARC_RPC_URL"] ?? "https://rpc.blockdaemon.mainnet.arc.io", { timeout: 12_000 }),
      http("https://rpc.blockdaemon.mainnet.arc.io", { timeout: 12_000 }),
    ]),
  },
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
