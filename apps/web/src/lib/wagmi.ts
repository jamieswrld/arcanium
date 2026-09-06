import { createConfig, fallback, http } from "wagmi";
import { base } from "viem/chains";
import { injected } from "wagmi/connectors";
import { arcTestnet } from "./bridgeClient";
import { arcTransport } from "./arcRpc";
import type { ChainKey } from "./chains";

/**
 * Wagmi config: Arc, plus Base purely as a bridge source.
 *
 * Arcanium launches and trades on Arc and nowhere else. Base is present only so
 * the CCTP bridge can approve and burn USDC there to mint it on Arc — it is
 * never a launch or trading venue. EIP-6963 discovery surfaces every installed
 * wallet.
 */
export const wagmiConfig = createConfig({
  chains: [arcTestnet, base],
  connectors: [injected({ shimDisconnect: true })],
  multiInjectedProviderDiscovery: true,
  /**
   * Fold bursts of reads into one Multicall3 request.
   *
   * Without this every hook doing a read makes its own eth_call. The portfolio
   * alone fires one balanceOf per launched token, and Arc drops a measurable
   * share of a parallel burst that size — measured at 40 in flight, 22 came
   * back. Each dropped call is caught and turned into 0n by its caller, so the
   * failure mode was a balance quietly reading zero rather than an error.
   *
   * The server-side client has had this since it was written; the browser never
   * did.
   */
  batch: {
    [arcTestnet.id]: { multicall: { wait: 16, batchSize: 512 } },
    [base.id]: { multicall: true },
  },
  transports: {
    [arcTestnet.id]: arcTransport({ browser: true }),
    [base.id]: fallback([
      http(process.env["NEXT_PUBLIC_BASE_RPC_URL"] ?? "https://mainnet.base.org", { timeout: 12_000 }),
      http("https://base.publicnode.com", { timeout: 12_000 }),
    ]),
  },
});

/** The viem chain object for a launch chain. Arc is the only one. */
export function viemChainFor(_key: ChainKey) {
  return arcTestnet;
}

/**
 * Put the wallet on Arc, and confirm it actually got there.
 *
 * switchChain resolves optimistically, and a wallet that has never seen the
 * network has to be asked to add it first. Writing without verifying produced a
 * chain-mismatch error mid-trade that no user could act on.
 */
export async function ensureChain(
  _key: ChainKey,
  currentChainId: number | undefined,
  switchChainAsync: (args: { chainId: number }) => Promise<unknown>,
): Promise<void> {
  if (currentChainId === arcTestnet.id) return;
  try {
    await switchChainAsync({ chainId: arcTestnet.id });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/reject|denied|User rejected/i.test(msg)) {
      throw new Error("Switch your wallet to Arc to continue.");
    }
    throw new Error(
      `Couldn't switch to Arc. Add it to your wallet (chain ID ${arcTestnet.id}) and try again.`,
    );
  }
}

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
