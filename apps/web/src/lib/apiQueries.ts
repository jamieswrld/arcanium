import "server-only";
import { getDb } from "@/lib/db";
import { getChain } from "@/lib/chains";
import { indexerHealth } from "@/lib/indexed";

/**
 * Indexed reads backing the public API.
 *
 * Every function returns `null` when the indexer cannot answer — absent, behind,
 * or the database unreachable. Callers turn that into a 503 rather than an empty
 * array, because "no trades" and "we cannot currently tell you" are different
 * answers and a public API must not conflate them.
 */

function addressBuf(address: string): Buffer {
  return Buffer.from(address.replace(/^0x/, ""), "hex");
}

function toHex(v: unknown): string {
  if (Buffer.isBuffer(v)) return `0x${v.toString("hex")}`;
  return typeof v === "string" ? v : "";
}

async function ready(): Promise<boolean> {
  const health = await indexerHealth().catch(() => null);
  return health !== null && health.caughtUp;
}

export interface TradeRow {
  readonly txHash: string;
  readonly blockNumber: string;
  readonly timestamp: string;
  readonly side: "buy" | "sell";
  readonly trader: string;
  /** Token amount in base units (18 decimals). */
  readonly amountToken: string;
  /** Trade value in 6-decimal USD micro-units. */
  readonly valueUsdUnits: string;
  /** Execution price, USD per whole token, scaled 1e18. */
  readonly priceUsdE18: string;
}

export async function tradesFor(
  address: string,
  limit: number,
  offset: number,
): Promise<TradeRow[] | null> {
  const sql = getDb();
  if (sql === null || !(await ready())) return null;
  const chainId = getChain("arc").id;

  try {
    const rows = await sql<Record<string, unknown>[]>`
      SELECT tx_hash, block_number, block_time, is_buy, amount_token,
             volume_usd_e6, price_usd_e18, recipient
      FROM swaps
      WHERE token_address = ${addressBuf(address)} AND chain_id = ${chainId}
      ORDER BY block_time DESC, block_number DESC
      LIMIT ${limit} OFFSET ${offset}
    `;
    return rows.map((r) => ({
      txHash: toHex(r["tx_hash"]),
      blockNumber: String(r["block_number"] ?? "0"),
      timestamp: new Date(String(r["block_time"])).toISOString(),
      side: r["is_buy"] === true ? "buy" : "sell",
      trader: toHex(r["recipient"]),
      amountToken: String(r["amount_token"] ?? "0"),
      valueUsdUnits: String(r["volume_usd_e6"] ?? "0"),
      priceUsdE18: String(r["price_usd_e18"] ?? "0"),
    }));
  } catch {
    return null;
  }
}

export interface HolderRow {
  readonly address: string;
  /** Balance in base units (18 decimals). */
  readonly balance: string;
  /** Share of the fixed 1,000,000,000 supply, to two decimals. */
  readonly sharePct: number;
}

const FIXED_SUPPLY = 1_000_000_000n * 10n ** 18n;

export async function holdersFor(
  address: string,
  limit: number,
  offset: number,
): Promise<HolderRow[] | null> {
  const sql = getDb();
  if (sql === null || !(await ready())) return null;

  try {
    const rows = await sql<Record<string, unknown>[]>`
      SELECT holder, balance
      FROM holders
      WHERE token_address = ${addressBuf(address)} AND balance > 0
      ORDER BY balance DESC
      LIMIT ${limit} OFFSET ${offset}
    `;
    return rows.map((r) => {
      const balance = BigInt(String(r["balance"] ?? "0"));
      return {
        address: toHex(r["holder"]),
        balance: balance.toString(),
        // Percent to two decimals via bigint, so no float touches a balance.
        sharePct: Number((balance * 10_000n) / FIXED_SUPPLY) / 100,
      };
    });
  } catch {
    return null;
  }
}
