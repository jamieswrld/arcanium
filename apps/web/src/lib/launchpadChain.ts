import type { Hex, PublicClient } from "viem";
import { chainPublicClient } from "@/lib/chainRpc";
import type { LaunchChain } from "@/lib/chains";
import {
  erc20MetaAbi,
  factoryAbi,
  isHidden,
  marketCapUsdUnits,
  modeDistributorAbi,
  poolAbi,
  priceUsdE18,
  type LaunchpadToken,
} from "@/lib/launchpad";

/**
 * Chain-parameterised launchpad reads.
 *
 * `launchpad.ts` remains the Arc-specific path, unchanged and battle-tested;
 * this module generalises the same logic over the chain registry so Robinhood
 * and BNB behave identically. The only real difference between chains is the
 * quote asset's decimals, which flows into the price math and the graduation
 * threshold.
 *
 * Every factory generation on a chain is scanned. Tokens are NEVER dropped
 * because a factory was upgraded — each generation stays listed forever.
 */

export interface ChainTokens {
  readonly chain: LaunchChain;
  readonly tokens: readonly LaunchpadToken[];
  /** True when no RPC answered — an outage, not an empty launchpad. */
  readonly unreachable: boolean;
}

const LIST_TTL_MS = 15_000;
const MODE_TTL_MS = 120_000;

const listCache = new Map<string, { at: number; value: ChainTokens }>();
const inFlight = new Map<string, Promise<ChainTokens>>();
const modeCache = new Map<string, { at: number; mode: number | null }>();

/** Mode lookups are cached separately and never block a listing: a token's
 *  mode is immutable, so once known it is known forever. */
async function fetchModes(
  client: PublicClient,
  chain: LaunchChain,
  tokens: readonly Hex[],
): Promise<Map<string, number | null>> {
  const out = new Map<string, number | null>();
  const distributor = chain.modeDistributor;
  if (distributor === undefined) return out;

  const misses: Hex[] = [];
  for (const t of tokens) {
    const key = `${chain.key}:${t.toLowerCase()}`;
    const hit = modeCache.get(key);
    if (hit !== undefined && (hit.mode !== null || Date.now() - hit.at < MODE_TTL_MS)) {
      out.set(t.toLowerCase(), hit.mode);
    } else {
      misses.push(t);
    }
  }
  if (misses.length === 0) return out;

  await Promise.all(
    misses.map(async (t) => {
      const mode = await (async (): Promise<number | null> => {
        const isSet = await client
          .readContract({ address: distributor, abi: modeDistributorAbi, functionName: "modeSet", args: [t] })
          .catch(() => false);
        if (!isSet) return null;
        const m = await client
          .readContract({ address: distributor, abi: modeDistributorAbi, functionName: "modeOf", args: [t] })
          .catch(() => null);
        return m === null ? null : Number(m);
      })();
      modeCache.set(`${chain.key}:${t.toLowerCase()}`, { at: Date.now(), mode });
      out.set(t.toLowerCase(), mode);
    }),
  );
  return out;
}

async function fetchTokenFrom(
  client: PublicClient,
  chain: LaunchChain,
  factory: Hex,
  token: Hex,
): Promise<LaunchpadToken | null> {
  const [launchedToken, creator, pairToken, pool, positionId] = await client.readContract({
    address: factory,
    abi: factoryAbi,
    functionName: "launches",
    args: [token],
  });
  if (launchedToken === "0x0000000000000000000000000000000000000000") return null;

  const [name, symbol, slot0, quoteBalance] = await Promise.all([
    client.readContract({ address: token, abi: erc20MetaAbi, functionName: "name" }),
    client.readContract({ address: token, abi: erc20MetaAbi, functionName: "symbol" }),
    client.readContract({ address: pool, abi: poolAbi, functionName: "slot0" }),
    client.readContract({ address: pairToken, abi: erc20MetaAbi, functionName: "balanceOf", args: [pool] }),
  ]);

  const tokenIsToken0 = token.toLowerCase() < pairToken.toLowerCase();
  const priceE18 = priceUsdE18(slot0[0], tokenIsToken0, chain.quote.decimals);
  return {
    token,
    name,
    symbol,
    creator,
    pairToken,
    pool,
    positionId,
    priceE18,
    marketCapUnits: marketCapUsdUnits(priceE18),
    quoteBalance,
    // A pool holding 9,000 of the quote asset is graduated — a milestone label
    // only. It never unlocks liquidity or changes the market.
    graduated: quoteBalance >= chain.graduationUnits,
    mode: null,
  };
}

/** Every launch on a chain, newest first, across all factory generations. */
export async function fetchTokensOn(chain: LaunchChain): Promise<ChainTokens> {
  if (chain.factories.length === 0) {
    return { chain, tokens: [], unreachable: false };
  }
  const cached = listCache.get(chain.key);
  if (cached !== undefined && Date.now() - cached.at < LIST_TTL_MS) return cached.value;

  const pending = inFlight.get(chain.key);
  if (pending !== undefined) return pending; // coalesce concurrent requests

  const run = (async (): Promise<ChainTokens> => {
    const client = chainPublicClient(chain);
    const generations = await Promise.all(
      chain.factories.map(async (factory) => {
        const count = await client
          .readContract({ address: factory, abi: factoryAbi, functionName: "allTokensLength" })
          .catch(() => 0n);
        const addresses = await Promise.all(
          Array.from({ length: Number(count) }, (_, i) =>
            client.readContract({ address: factory, abi: factoryAbi, functionName: "allTokens", args: [BigInt(i)] }),
          ),
        );
        const details = await Promise.all(
          addresses
            .filter((t) => !isHidden(t))
            .map((t) => fetchTokenFrom(client, chain, factory, t).catch(() => null)),
        );
        return details.filter((d): d is LaunchpadToken => d !== null).reverse();
      }),
    );

    const reachable =
      generations.some((g) => g.length > 0) ||
      (await client.getBlockNumber().then(() => true).catch(() => false));
    const flat = generations.flat();
    const modes = await fetchModes(client, chain, flat.map((t) => t.token)).catch(
      () => new Map<string, number | null>(),
    );
    const tokens = flat.map((t) => ({ ...t, mode: modes.get(t.token.toLowerCase()) ?? null }));
    const value: ChainTokens = { chain, tokens, unreachable: !reachable };
    if (tokens.length > 0 || !reachable) listCache.set(chain.key, { at: Date.now(), value });
    return value;
  })();

  inFlight.set(chain.key, run);
  try {
    return await run;
  } finally {
    inFlight.delete(chain.key);
  }
}

/** One token on one chain, checked against every factory generation. */
export async function fetchTokenOn(chain: LaunchChain, token: Hex): Promise<LaunchpadToken | null> {
  if (chain.factories.length === 0) return null;
  const client = chainPublicClient(chain);
  const found = await Promise.all(
    chain.factories.map((f) => fetchTokenFrom(client, chain, f, token).catch(() => null)),
  );
  const base = found.find((v) => v !== null) ?? null;
  if (base === null) return null;
  const modes = await fetchModes(client, chain, [base.token]).catch(
    () => new Map<string, number | null>(),
  );
  return { ...base, mode: modes.get(base.token.toLowerCase()) ?? null };
}
