import { z } from "zod";

const address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, "expected 0x-prefixed 20-byte address");

const httpsUrl = z.string().url();

/** Integer-valued env var parsed as bigint (never float). */
const bigintString = z
  .string()
  .regex(/^[0-9]+$/, "expected unsigned integer string")
  .transform((v) => BigInt(v));

const intString = z
  .string()
  .regex(/^[0-9]+$/, "expected unsigned integer string")
  .transform((v) => Number.parseInt(v, 10));

const boolString = z
  .enum(["true", "false"])
  .transform((v) => v === "true");

/**
 * One network profile. Every chain-specific value is env-driven; nothing is
 * compiled in for arcMainnet (ADR 0006).
 */
const networkSchema = z.object({
  chainId: intString,
  rpcUrl: httpsUrl,
  explorerUrl: httpsUrl,
  usdcAddress: address.optional(),
  deploymentBlock: bigintString.optional(),
  confirmations: intString,
});

export const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    ARCH_NETWORK_PROFILE: z
      .enum(["baseSepolia", "baseMainnet", "arcTestnet", "arcMainnet"])
      .describe("active profile for single-network services")
      .optional(),

    // ---- Feature gates (must stay false until address book verified; ADR 0006)
    ENABLE_ARC_MAINNET: boolString.default("false"),
    ENABLE_REAL_BRIDGE: boolString.default("false"),
    ENABLE_REAL_TRADING: boolString.default("false"),

    // ---- Fees (bps and raw quote units; bigint-safe)
    BRIDGE_DEPOSIT_FEE_BPS: bigintString.default("1500"),
    BRIDGE_REDEEM_FEE_BPS: bigintString.default("0"),
    PAIR_FEE_CREATOR_SHARE_BPS: bigintString.default("3000"),
    PAIR_FEE_PROTOCOL_SHARE_BPS: bigintString.default("7000"),
    GAS_STATION_MARGIN_BPS: bigintString.default("500"),
    UNISWAP_POOL_FEE: intString.default("10000"),
    // 105% of Envelope's on-chain launchFee() of 50_000_000 (verified 2026-07-28).
    LAUNCH_FEE_QUOTE_UNITS: bigintString.default("52500000"),

    // ---- Base networks
    BASE_SEPOLIA_RPC_URL: httpsUrl.optional(),
    BASE_SEPOLIA_EXPLORER_URL: httpsUrl.default("https://sepolia.basescan.org"),
    BASE_SEPOLIA_CHAIN_ID: intString.default("84532"),
    BASE_SEPOLIA_USDC_ADDRESS: address.optional(),
    BASE_SEPOLIA_CONFIRMATIONS: intString.default("10"),
    BASE_SEPOLIA_VAULT_DEPLOY_BLOCK: bigintString.optional(),

    BASE_MAINNET_RPC_URL: httpsUrl.optional(),
    BASE_MAINNET_EXPLORER_URL: httpsUrl.default("https://basescan.org"),
    BASE_MAINNET_CHAIN_ID: intString.default("8453"),
    BASE_MAINNET_USDC_ADDRESS: address.optional(),
    BASE_MAINNET_CONFIRMATIONS: intString.default("30"),
    BASE_MAINNET_VAULT_DEPLOY_BLOCK: bigintString.optional(),

    // ---- Arc networks (mainnet values intentionally have no defaults)
    ARC_TESTNET_RPC_URL: httpsUrl.default("https://rpc.testnet.arc.network"),
    ARC_TESTNET_EXPLORER_URL: httpsUrl.default("https://testnet.arcscan.app"),
    ARC_TESTNET_CHAIN_ID: intString.default("5042002"),
    ARC_TESTNET_USDC_ADDRESS: address.default(
      "0x3600000000000000000000000000000000000000",
    ),
    ARC_TESTNET_CONFIRMATIONS: intString.default("5"),

    ARC_MAINNET_RPC_URL: httpsUrl.optional(),
    ARC_MAINNET_EXPLORER_URL: httpsUrl.optional(),
    ARC_MAINNET_CHAIN_ID: intString.optional(),
    ARC_MAINNET_USDC_ADDRESS: address.optional(),
    ARC_MAINNET_CONFIRMATIONS: intString.default("10"),

    // ---- Uniswap v3 (per active Arc network; no compiled-in defaults)
    UNISWAP_V3_FACTORY_ADDRESS: address.optional(),
    UNISWAP_V3_POSITION_MANAGER_ADDRESS: address.optional(),
    UNISWAP_V3_SWAP_ROUTER_ADDRESS: address.optional(),
    UNISWAP_V3_QUOTER_ADDRESS: address.optional(),

    // ---- Arch contract addresses (filled per deployment)
    ARCH_USD_ADDRESS: address.optional(),
    ARCH_VAULT_BASE_ADDRESS: address.optional(),
    ARCH_BRIDGE_ARC_ADDRESS: address.optional(),
    ARCH_GAS_STATION_ADDRESS: address.optional(),
    ARCH_LAUNCHPAD_FACTORY_ADDRESS: address.optional(),
    ARCH_LIQUIDITY_VAULT_ADDRESS: address.optional(),
    ARCH_FEE_DISTRIBUTOR_ADDRESS: address.optional(),
    ARCH_GRADUATION_REGISTRY_ADDRESS: address.optional(),

    // ---- Bridge limits and policy
    BRIDGE_MIN_DEPOSIT_UNITS: bigintString.default("25000000"),
    BRIDGE_MAX_DEPOSIT_UNITS: bigintString.default("100000000000"),
    BRIDGE_MAX_RELEASE_PER_TX_UNITS: bigintString.default("100000000000"),
    BRIDGE_MAX_RELEASE_PER_WINDOW_UNITS: bigintString.default("500000000000"),
    BRIDGE_RELEASE_WINDOW_SECONDS: intString.default("3600"),

    // ---- Graduation
    GRADUATION_QUOTE_UNITS: bigintString.default("9000000000"),

    // ---- Infrastructure
    DATABASE_URL: z.string().min(1).optional(),
    REDIS_URL: z.string().min(1).optional(),
    S3_ENDPOINT: httpsUrl.or(z.string().startsWith("http://")).optional(),
    S3_BUCKET: z.string().min(1).optional(),
    S3_ACCESS_KEY_ID: z.string().min(1).optional(),
    S3_SECRET_ACCESS_KEY: z.string().min(1).optional(),

    // ---- Service ports
    API_PORT: intString.default("4000"),
    ADMIN_PORT: intString.default("4100"),
    GAS_RELAYER_PORT: intString.default("4200"),

    // ---- Observability
    LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error"]).default("info"),
    OTEL_EXPORTER_OTLP_ENDPOINT: z.string().optional(),
    METRICS_PORT: intString.default("9464"),
  })
  .superRefine((env, ctx) => {
    if (env.ENABLE_ARC_MAINNET) {
      const required: Array<[string, unknown]> = [
        ["ARC_MAINNET_RPC_URL", env.ARC_MAINNET_RPC_URL],
        ["ARC_MAINNET_EXPLORER_URL", env.ARC_MAINNET_EXPLORER_URL],
        ["ARC_MAINNET_CHAIN_ID", env.ARC_MAINNET_CHAIN_ID],
        ["ARC_MAINNET_USDC_ADDRESS", env.ARC_MAINNET_USDC_ADDRESS],
      ];
      for (const [name, value] of required) {
        if (value === undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `${name} is required when ENABLE_ARC_MAINNET=true (verify against official Arc/Circle sources first — ADR 0006)`,
            path: [name],
          });
        }
      }
    }
    if (
      env.PAIR_FEE_CREATOR_SHARE_BPS + env.PAIR_FEE_PROTOCOL_SHARE_BPS !==
      10_000n
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "PAIR_FEE_CREATOR_SHARE_BPS + PAIR_FEE_PROTOCOL_SHARE_BPS must equal 10000",
        path: ["PAIR_FEE_CREATOR_SHARE_BPS"],
      });
    }
  });

export type ArchEnv = z.infer<typeof envSchema>;

/**
 * Parse and validate process.env. Throws with a readable report on failure so
 * a misconfigured service refuses to start instead of running with defaults it
 * should not have.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): ArchEnv {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const lines = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${lines}`);
  }
  return parsed.data;
}

export const networkProfileSchema = networkSchema;
