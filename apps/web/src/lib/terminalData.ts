import { parseAbiItem, type Hex, type PublicClient } from "viem";
import type { LaunchpadToken } from "@/lib/launchpad";
import { FACTORY_ADDRESS, LEGACY_FACTORY_ADDRESS } from "@/lib/launchpad";

/**
 * Terminal feed data: per-token 24h volume, launch age, and the cross-pool
 * recent-trades tape. One cached chunked walk serves the whole terminal page.
 */

const swapEvent = parseAbiItem(
  "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)",
);
const launchedEvent = parseAbiItem(
  "event Launched(address indexed token, address indexed creator, address pairToken, address pool, uint256 positionId, string metadataUri)",
);

export interface TerminalTrade {
  readonly token: Hex;
  readonly symbol: string;
  readonly wallet: string;
  readonly usd6: string; // signed 6d units as string (serializable)
  readonly isBuy: boolean;
  readonly ageSec: number;
}

export interface TerminalData {
  readonly tipBlock: string;
  readonly vol24h: Record<string, string>; // token(lower) -> 6d units
  readonly ageSec: Record<string, number>; // token(lower) -> seconds since launch
  readonly trades: TerminalTrade[];
}

const CHUNK = 45_000n;
const BLOCKS_24H = 172_800n; // ~0.5s blocks
const BLOCK_SEC = 0.5;

const launchBlockCache = new Map<string, bigint>(); // token(lower) -> block, permanent

const TTL_MS = 45_000;
let cache: { at: number; value: TerminalData } | null = null;
let inFlight: Promise<TerminalData> | null = null;

async function loadLaunchBlocks(client: PublicClient, tokens: readonly LaunchpadToken[], tip: bigint): Promise<void> {
  if (tokens.every((t) => launchBlockCache.has(t.token.toLowerCase()))) return;
  const factories = [FACTORY_ADDRESS, LEGACY_FACTORY_ADDRESS].filter((f): f is Hex => f !== undefined);
  let end = tip;
  for (let i = 0; i < 12; i++) {
    const start = end >= CHUNK ? end - CHUNK + 1n : 0n;
    let logs;
    try {
      logs = await client.getLogs({ address: factories, event: launchedEvent, fromBlock: start, toBlock: end });
    } catch { break; }
    for (const l of logs) {
      const t = l.args.token;
      if (t !== undefined && l.blockNumber !== null) launchBlockCache.set(t.toLowerCase(), l.blockNumber);
    }
    if (start === 0n || tokens.every((t) => launchBlockCache.has(t.token.toLowerCase()))) break;
    end = start - 1n;
  }
}

export async function fetchTerminalData(client: PublicClient, tokens: readonly LaunchpadToken[]): Promise<TerminalData> {
  if (cache !== null && Date.now() - cache.at < TTL_MS) return cache.value;
  if (inFlight !== null) return inFlight;
  inFlight = (async () => {
    const tip = await client.getBlockNumber();
    const pools = tokens.map((t) => t.pool);
    const byPool = new Map(tokens.map((t) => [t.pool.toLowerCase(), t] as const));
    await loadLaunchBlocks(client, tokens, tip).catch(() => undefined);

    const vol = new Map<string, bigint>();
    const trades: Array<{ token: Hex; symbol: string; wallet: string; usd6: bigint; isBuy: boolean; block: bigint }> = [];
    const cutoff = tip > BLOCKS_24H ? tip - BLOCKS_24H : 0n;

    let end = tip;
    for (let i = 0; i < 5 && pools.length > 0; i++) {
      const start = end >= CHUNK ? end - CHUNK + 1n : 0n;
      let logs;
      try {
        logs = await client.getLogs({ address: pools as Hex[], event: swapEvent, fromBlock: start, toBlock: end });
      } catch { break; }
      for (const l of logs) {
        const t = byPool.get(l.address.toLowerCase());
        if (t === undefined) continue;
        const tokenIs0 = t.token.toLowerCase() < t.pairToken.toLowerCase();
        const quoteDelta = tokenIs0 ? (l.args.amount1 ?? 0n) : (l.args.amount0 ?? 0n);
        const abs = quoteDelta < 0n ? -quoteDelta : quoteDelta;
        if ((l.blockNumber ?? 0n) >= cutoff) {
          const k = t.token.toLowerCase();
          vol.set(k, (vol.get(k) ?? 0n) + abs);
        }
        trades.push({
          token: t.token,
          symbol: t.symbol,
          wallet: (l.args.recipient ?? "0x") as string,
          usd6: quoteDelta > 0n ? abs : -abs,
          isBuy: quoteDelta > 0n,
          block: l.blockNumber ?? 0n,
        });
      }
      if (start === 0n) break;
      end = start - 1n;
    }

    trades.sort((a, b) => (b.block > a.block ? 1 : b.block < a.block ? -1 : 0));
    const value: TerminalData = {
      tipBlock: tip.toString(),
      vol24h: Object.fromEntries([...vol.entries()].map(([k, v]) => [k, v.toString()])),
      ageSec: Object.fromEntries(
        tokens.map((t) => {
          const lb = launchBlockCache.get(t.token.toLowerCase());
          return [t.token.toLowerCase(), lb === undefined ? -1 : Math.max(0, Math.round(Number(tip - lb) * BLOCK_SEC))];
        }),
      ),
      trades: trades.slice(0, 40).map((tr) => ({
        token: tr.token,
        symbol: tr.symbol,
        wallet: tr.wallet,
        usd6: tr.usd6.toString(),
        isBuy: tr.isBuy,
        ageSec: Math.max(0, Math.round(Number(tip - tr.block) * BLOCK_SEC)),
      })),
    };
    cache = { at: Date.now(), value };
    return value;
  })();
  try {
    return await inFlight;
  } finally {
    inFlight = null;
  }
}

/** Humanize seconds: 42s · 7m · 3h · 2d. */
export function ago(sec: number): string {
  if (sec < 0) return "—";
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86_400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86_400)}d ago`;
}
