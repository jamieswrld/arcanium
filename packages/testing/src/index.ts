import { envSchema, type ArchEnv } from "@arch/config";

/**
 * A fully-valid development env for unit tests: local anvil chains, local
 * infra, all real-funds gates off. Tests override individual keys as needed.
 */
export function testEnv(overrides: Record<string, string> = {}): ArchEnv {
  const base: Record<string, string> = {
    NODE_ENV: "test",
    BASE_SEPOLIA_RPC_URL: "https://sepolia.base.org",
    DATABASE_URL: "postgres://arch:arch@localhost:5432/arch_test",
    REDIS_URL: "redis://localhost:6379/1",
    ...overrides,
  };
  return envSchema.parse(base);
}
