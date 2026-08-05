import { env } from "@/env";

/**
 * Worker entrypoint. Runs directly under Bun (`bun run worker`), outside
 * Next.js — see the import boundary in eslint.config.mjs.
 *
 * M2 fills in the loop described in the plan: claim a run from run_queue with
 * FOR UPDATE SKIP LOCKED, clone the repo on the host, launch the sandbox, drive
 * the Agent SDK, and append each normalized event to run_event. For now this is
 * just the process shell, so the script exists, boots, and shuts down cleanly.
 */
async function main() {
  const workerId = env.WORKER_ID ?? `local-${process.pid}`;
  console.log(
    `[worker] ${workerId} up — concurrency=${env.WORKER_CONCURRENCY}, heartbeat=${env.WORKER_HEARTBEAT_SECONDS}s`,
  );
  console.log("[worker] no queue to drain yet; the run loop lands in M2.");
}

let shuttingDown = false;
function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  // Once the run loop exists this is where in-flight runs stop heartbeating
  // and release their queue lock so the reaper does not have to time them out.
  console.log(`[worker] ${signal} received, shutting down.`);
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

await main();
