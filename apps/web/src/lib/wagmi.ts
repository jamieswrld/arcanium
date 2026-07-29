import { createConfig, fallback, http } from "wagmi";
import { injected } from "wagmi/connectors";
import { arcTestnet, baseChain } from "./bridgeClient";

/**
 * Wagmi config: Base Sepolia + Arc testnet. EIP-6963 multi-provider discovery
 * is on by default, so every installed wallet (MetaMask, Rabby, Coinbase
 * Wallet, Rainbow, …) surfaces as its own connector for the picker. The
 * `injected()` connector is the fallback for wallets that don't announce via
 * EIP-6963.
 */
// Default the Base RPC to the correct network for the configured chain: a
// mainnet chain id must never be pointed at a Sepolia RPC (that mismatch makes
// every Base read — USDC balance, allowances — silently return nothing).
const baseRpcDefault = baseChain.id === 8453 ? "https://mainnet.base.org" : "https://sepolia.base.org";
const baseRpc = process.env["NEXT_PUBLIC_BASE_RPC_URL"] ?? baseRpcDefault;

// A fallback transport keeps balances reliable: if the primary Base RPC rate-
// limits or drops a request, viem retries the next endpoint instead of leaving
// the read undefined (which is what blanks a balance in the UI).
const baseTransport =
  baseChain.id === 8453
    ? fallback([http(baseRpc, { timeout: 12_000 }), http("https://mainnet.base.org", { timeout: 12_000 }), http("https://base.publicnode.com", { timeout: 12_000 })])
    : http(baseRpc);

export const wagmiConfig = createConfig({
  chains: [baseChain, arcTestnet],
  connectors: [injected({ shimDisconnect: true })],
  multiInjectedProviderDiscovery: true,
  transports: {
    [baseChain.id]: baseTransport,
    [arcTestnet.id]: http(),
  },
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
