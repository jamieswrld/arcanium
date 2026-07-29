#!/usr/bin/env node
/**
 * Railway/VPS entrypoint: runs the three always-on Arch backend processes in
 * one service (cheapest for beta) and restarts any that exit. Each is an
 * independent async loop; they share no state in-process, so co-hosting them
 * is purely operational convenience, not coupling. Split into separate
 * services later for isolation if desired.
 */
import { spawn } from "node:child_process";

const services = [
  { name: "bridge-worker", entry: "apps/bridge-worker/dist/main.js" },
  { name: "redeem-worker", entry: "apps/redeem-worker/dist/main.js" },
  { name: "indexer", entry: "apps/indexer/dist/main.js" },
];

function start(svc) {
  const child = spawn("node", [svc.entry], { stdio: "inherit", env: process.env });
  child.on("exit", (code) => {
    console.error(`[run-services] ${svc.name} exited (code ${code}); restarting in 5s`);
    setTimeout(() => start(svc), 5_000);
  });
  child.on("error", (err) => {
    console.error(`[run-services] ${svc.name} failed to spawn:`, err.message);
  });
  console.log(`[run-services] started ${svc.name}`);
}

for (const svc of services) start(svc);

// Keep the parent alive.
process.stdin.resume();
