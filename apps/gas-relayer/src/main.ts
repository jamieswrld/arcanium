import { createServer } from "node:http";
import pino from "pino";
import { loadEnv, feeConfigFromEnv } from "@arch/config";

/**
 * Arc gas relayer — Milestone 1 skeleton.
 *
 * Milestone 4 implements: POST /v1/gas/quote (live gas × buffer + relayer cost
 * + visible 5% margin, expiry, permitSpender), POST /v1/gas/drip (EIP-2612
 * permit validation, idempotency keys, per-user rate limits, per-action caps,
 * 409 on duplicate in-flight). This skeleton serves health and the declared
 * action table only; quote/drip return explicit 501s.
 */
const env = loadEnv();
const log = pino({ level: env.LOG_LEVEL, name: "arch-gas-relayer" });
const fees = feeConfigFromEnv(env);

const ACTIONS = [
  { actionId: 0, name: "swap" },
  { actionId: 1, name: "token launch" },
  { actionId: 2, name: "redemption" },
  { actionId: 3, name: "approval" },
] as const;

const server = createServer((req, res) => {
  const url = req.url ?? "/";
  if (url === "/healthz") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
    return;
  }
  if (url === "/v1/gas/actions") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        actions: ACTIONS,
        serviceMarginBps: fees.gasStationMarginBps.toString(),
      }),
    );
    return;
  }
  res.writeHead(501, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      error: "not_implemented",
      detail: "Gas quote/drip endpoints arrive in Milestone 4.",
    }),
  );
});

server.listen(env.GAS_RELAYER_PORT, () => {
  log.info({ port: env.GAS_RELAYER_PORT }, "gas-relayer skeleton listening");
});
