import type { ArchEnv } from "./env.js";

export interface FeatureFlags {
  /** Arc mainnet may only be enabled after the address book is verified against official sources (ADR 0006). */
  readonly arcMainnet: boolean;
  /** Real-funds bridging (deposits/mints/releases). */
  readonly realBridge: boolean;
  /** Real-funds trading through deployed pools. */
  readonly realTrading: boolean;
}

export function featureFlagsFromEnv(env: ArchEnv): FeatureFlags {
  return {
    arcMainnet: env.ENABLE_ARC_MAINNET,
    realBridge: env.ENABLE_REAL_BRIDGE,
    realTrading: env.ENABLE_REAL_TRADING,
  };
}
