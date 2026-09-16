import { createConfig, fallback, http } from "wagmi";
import { injected } from "wagmi/connectors";
import { arcTestnet } from "./bridgeClient";
import { arcTransport } from "./arcRpc";
import { BRIDGE_CHAINS } from "./bridgeChains";
import type { ChainKey } from "./chains";

/**
 * Wagmi config: Arc, plus Base purely as a bridge source.
 *
 * Arcanium launches and trades on Arc and nowhere else. Base is present only so
 * the CCTP bridge can approve and burn USDC there to mint it on Arc — it is
 * never a launch or trading venue. EIP-6963 discovery surfaces every installed
 * wallet.
 */
/**
 * Every chain the bridge can reach, so the wallet can be switched to any of
 * them. Arc is first because it is where the product lives; the rest exist
 * only as bridge sources and destinations.
 */
const bridgeChains = BRIDGE_CHAINS.map((c) => c.chain);

export const wagmiConfig = createConfig({
  chains: [arcTestnet, ...bridgeChains] as [typeof arcTestnet, ...typeof bridgeChains],
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
    // Every bridge chain has Multicall3, and the bridge reads a balance and an
    // allowance per chain, so folding those into one call is worth having
    // everywhere rather than only on Base.
    ...Object.fromEntries(BRIDGE_CHAINS.map((c) => [c.chainId, { multicall: true }])),
  },
  transports: {
    [arcTestnet.id]: arcTransport({ browser: true }),
    // One entry per bridge chain, from the registry, so adding a chain there is
    // the only edit needed. Each falls back to the chain's own default RPC,
    // because a public endpoint that is rate-limiting should degrade rather
    // than make the chain unselectable.
    ...Object.fromEntries(
      BRIDGE_CHAINS.map((c) => [
        c.chainId,
        fallback([http(c.rpcUrl, { timeout: 12_000 }), http(undefined, { timeout: 12_000 })]),
      ]),
    ),
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
