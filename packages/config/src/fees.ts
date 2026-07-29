import type { ArchEnv } from "./env.js";

export const BPS_DENOMINATOR = 10_000n;

/** Compiled-in hard caps mirrored by the contracts (ADR 0004). */
export const MAX_BRIDGE_DEPOSIT_FEE_BPS = 2_000n;
export const MAX_PAIR_FEE_SHARE_BPS = 10_000n;

export interface FeeConfig {
  /** Base→Arc bridge entry fee, in basis points (1500 = 15%). */
  readonly bridgeDepositFeeBps: bigint;
  /** Arc→Base redemption fee, in basis points (0 = free, one-for-one). */
  readonly bridgeRedeemFeeBps: bigint;
  /** Creator share of quote-side LP fees (3000 = 30%). */
  readonly pairFeeCreatorShareBps: bigint;
  /** Protocol share of quote-side LP fees (7000 = 70%). */
  readonly pairFeeProtocolShareBps: bigint;
  /** Visible gas-station margin over measured operational cost (500 = 5%). */
  readonly gasStationMarginBps: bigint;
  /** Uniswap v3 fee tier for launch pools (10000 = 1%). */
  readonly uniswapPoolFee: number;
  /** Launch fee in raw quote units (6 decimals). 52_500_000 = 52.5 aUSD. */
  readonly launchFeeQuoteUnits: bigint;
}

/**
 * Deployment/display defaults only. Live values MUST be read from contracts by
 * the frontend and API once deployed (ADR 0004); this config seeds deploys and
 * local development.
 */
export function feeConfigFromEnv(env: ArchEnv): FeeConfig {
  if (env.BRIDGE_DEPOSIT_FEE_BPS > MAX_BRIDGE_DEPOSIT_FEE_BPS) {
    throw new Error(
      `BRIDGE_DEPOSIT_FEE_BPS ${env.BRIDGE_DEPOSIT_FEE_BPS} exceeds hard cap ${MAX_BRIDGE_DEPOSIT_FEE_BPS}`,
    );
  }
  return {
    bridgeDepositFeeBps: env.BRIDGE_DEPOSIT_FEE_BPS,
    bridgeRedeemFeeBps: env.BRIDGE_REDEEM_FEE_BPS,
    pairFeeCreatorShareBps: env.PAIR_FEE_CREATOR_SHARE_BPS,
    pairFeeProtocolShareBps: env.PAIR_FEE_PROTOCOL_SHARE_BPS,
    gasStationMarginBps: env.GAS_STATION_MARGIN_BPS,
    uniswapPoolFee: env.UNISWAP_POOL_FEE,
    launchFeeQuoteUnits: env.LAUNCH_FEE_QUOTE_UNITS,
  };
}
