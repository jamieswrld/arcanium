import { createConfig, fallback, http } from "wagmi";
import { base, bsc } from "viem/chains";
import { defineChain } from "viem";
import { injected } from "wagmi/connectors";
import { arcTestnet } from "./bridgeClient";
import { arcTransport } from "./arcRpc";
import { chainTransport } from "./chainRpc";
import { getChain, type ChainKey } from "./chains";

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

/** The viem chain object for one of our launch chains. Passing this to
 *  writeContract (rather than a bare chainId) means viem always has the full
 *  definition — a wallet on the wrong network then reports the real chain name
 *  instead of "undefined", and can be prompted to add it. */
export function viemChainFor(key: ChainKey) {
  switch (key) {
    case "robinhood":
      return robinhoodChain;
    case "bnb":
      return bsc;
    case "arc":
      return arcTestnet;
  }
}

/**
 * Put the wallet on `chain`, and confirm it actually got there.
 *
 * switchChain resolves optimistically, and a wallet that has never seen the
 * network has to be asked to add it first. Writing without verifying produced
 * "current chain (5042) does not match target (4663 - undefined)" mid-trade.
 */
export async function ensureChain(
  key: ChainKey,
  currentChainId: number | undefined,
  switchChainAsync: (args: { chainId: number }) => Promise<unknown>,
): Promise<void> {
  const target = viemChainFor(key);
  if (currentChainId === target.id) return;
  try {
    await switchChainAsync({ chainId: target.id });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/reject|denied|User rejected/i.test(msg)) {
      throw new Error(`Switch your wallet to ${target.name} to continue.`);
    }
    throw new Error(
      `Couldn't switch to ${target.name}. Add it to your wallet (chain ID ${target.id}) and try again.`,
    );
  }
}
