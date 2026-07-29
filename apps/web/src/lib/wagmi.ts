import { createConfig, http } from "wagmi";
import { injected } from "wagmi/connectors";
import { arcTestnet, baseChain } from "./bridgeClient";

/**
 * Wagmi config: Base Sepolia + Arc testnet. EIP-6963 multi-provider discovery
 * is on by default, so every installed wallet (MetaMask, Rabby, Coinbase
 * Wallet, Rainbow, …) surfaces as its own connector for the picker. The
 * `injected()` connector is the fallback for wallets that don't announce via
 * EIP-6963.
 */
export const wagmiConfig = createConfig({
  chains: [baseChain, arcTestnet],
  connectors: [injected({ shimDisconnect: true })],
  multiInjectedProviderDiscovery: true,
  transports: {
    [baseChain.id]: http(
      process.env["NEXT_PUBLIC_BASE_RPC_URL"] ?? "https://sepolia.base.org",
    ),
    [arcTestnet.id]: http(),
  },
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
