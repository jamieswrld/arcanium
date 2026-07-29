import { createConfig, http } from "wagmi";
import { injected } from "wagmi/connectors";
import { arcTestnet, baseChain } from "./bridgeClient";

/**
 * Wagmi config: Base Sepolia + Arc testnet, injected connector with EIP-6963
 * multi-provider discovery (wagmi v2 default) — MetaMask, Rabby, Coinbase
 * Wallet, Rainbow extensions all surface automatically. WalletConnect mobile
 * pairing needs a WalletConnect Cloud project id and is added when one is
 * provisioned.
 */
export const wagmiConfig = createConfig({
  chains: [baseChain, arcTestnet],
  connectors: [injected()],
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
