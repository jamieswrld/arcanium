#!/usr/bin/env node
/**
 * Arc backend entrypoint: the indexer, and the fee keeper when it is configured.
 *
 * Deliberately narrower than run-services.mjs, which starts five processes
 * including the bridge and redeem workers. Those have their own credentials and
 * their own failure modes, and co-hosting them here would mean an unrelated
 * crash loop taking the indexer down with it — which is precisely the problem
 * this deployment exists to escape.
 *
 * The keeper only starts when KEEPER_PRIVATE_KEY is present. Running it without
 * one would crash-loop on boot, and an indexer that is up matters more than a
 * keeper that cannot sign: unswept fees accumulate harmlessly and the next
 * sweep collects them, while a stalled indexer degrades every page.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

const services = [{ name: "indexer", entry: "apps/indexer/dist/main.js", required: true }];

if (process.env.KEEPER_PRIVATE_KEY !== undefined && process.env.KEEPER_PRIVATE_KEY.trim() !== "") {
  services.push({ name: "keeper", entry: "apps/indexer/dist/keeper.js", required: false });
} else {
  console.log("[run] KEEPER_PRIVATE_KEY not set — starting the indexer only");
}

/** Back off on repeated failures so a broken build does not spin the CPU. */
function start(svc, attempt = 0) {
  if (!existsSync(svc.entry)) {
    console.error(`[run] ${svc.name}: ${svc.entry} is missing — did the build run?`);
    if (svc.required) process.exit(1);
    return;
  }
  const child = spawn("node", [svc.entry], { stdio: "inherit", env: process.env });
  child.on("exit", (code) => {
    const delay = Math.min(5_000 * 2 ** attempt, 60_000);
    console.error(`[run] ${svc.name} exited (${code}); restarting in ${delay / 1000}s`);
    setTimeout(() => start(svc, attempt + 1), delay);
  });
  child.on("error", (err) => {
    console.error(`[run] ${svc.name} failed to spawn:`, err.message);
  });
  console.log(`[run] started ${svc.name}`);
}

for (const svc of services) start(svc);

process.stdin.resume();
