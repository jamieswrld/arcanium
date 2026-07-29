import { createServer } from "node:http";
import pino from "pino";
import { loadEnv, featureFlagsFromEnv } from "@arch/config";

/**
 * Restricted operational dashboard — Milestone 1 skeleton.
 *
 * Milestone 9 implements: bridge solvency (reserve vs supply), pending/failed
 * actions, relayer balances, indexer lag, pause states, migration readiness,
 * and the evidence-required reconciliation tools. Every admin action writes to
 * the append-only audit log (schema already provisioned).
 */
const env = loadEnv();
const log = pino({ level: env.LOG_LEVEL, name: "arch-admin" });
const flags = featureFlagsFromEnv(env);

const server = createServer((req, res) => {
  if ((req.url ?? "/") === "/healthz") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok", features: flags }));
    return;
  }
  res.writeHead(501, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      error: "not_implemented",
      detail: "Admin dashboard functionality arrives in Milestone 9.",
    }),
  );
});

server.listen(env.ADMIN_PORT, () => {
  log.info({ port: env.ADMIN_PORT }, "admin skeleton listening");
});
