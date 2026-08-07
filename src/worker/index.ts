import { db } from "@/db";
import { loadRunnableTemplate } from "@/db/queries/templates";
import { env } from "@/env";
import {
  claimNext,
  heartbeat,
  releaseClaim,
  reapStale,
  type ClaimedRun,
} from "@/lib/queue/claim";
import { executeRun } from "@/lib/runner/execute";
import { settleRun } from "@/lib/runner/settle";
import { prepareWorkdir, type PreparedWorkdir } from "@/lib/runner/workdir";

/**
 * Worker entrypoint. Runs directly under Bun (`bun run worker`), outside
 * Next.js — see the import boundary in eslint.config.mjs.
 *
 * Claim a run, prepare its checkout on the host, drive the agent, settle the
 * result. Everything interesting lives in src/lib; this file is the loop and
 * the liveness contract around it.
 */

const workerId = env.WORKER_ID ?? `local-${process.pid}`;
const heartbeatMs = env.WORKER_HEARTBEAT_SECONDS * 1000;
/** A claim is stale after three missed heartbeats, not one — a GC pause is not death. */
const staleAfterSeconds = env.WORKER_HEARTBEAT_SECONDS * 3;
const IDLE_POLL_MS = 2_000;

type InFlight = {
  claim: ClaimedRun;
  abort: AbortController;
  /** Resolves when the run has settled and its workdir is gone. */
  done: Promise<void>;
};

const inFlight = new Map<string, InFlight>();
let shuttingDown = false;

/**
 * The port each run's proxy listens on.
 *
 * One proxy per run, because the token ceiling and the usage meter are per-run.
 * That means concurrent runs cannot share a fixed port, so above a concurrency
 * of one the OS assigns them — and says so at startup, because a firewall rule
 * written against SANDBOX_PROXY_PORT would then be pointing at nothing.
 */
const proxyPort = env.WORKER_CONCURRENCY === 1 ? env.SANDBOX_PROXY_PORT : 0;

function log(message: string) {
  console.log(`[worker ${workerId}] ${message}`);
}

async function runOne(claim: ClaimedRun, abort: AbortController): Promise<void> {
  let workdir: PreparedWorkdir | null = null;

  // Prove we are still alive, and notice when the reaper decided we were not.
  const beat = setInterval(() => {
    void heartbeat(db, claim.runId, workerId).then((held) => {
      if (held || abort.signal.aborted) return;
      log(`${claim.runId} was reaped out from under us — stopping`);
      abort.abort();
    });
  }, heartbeatMs);

  try {
    const template = await loadRunnableTemplate(db, claim.templateVersionId);
    if (!template) {
      throw new Error(`template version ${claim.templateVersionId} is missing`);
    }

    const repo = claim.inputs.repo;
    if (!repo) throw new Error("run has no repo input");

    workdir = await prepareWorkdir({ runId: claim.runId, repo });

    const result = await executeRun(db, {
      runId: claim.runId,
      workdir: workdir.path,
      template,
      inputs: claim.inputs,
      issue: claim.inputs.issue ?? "",
      abortController: abort,
      proxyPort,
    });

    const settled = await settleRun(db, {
      runId: claim.runId,
      workerId,
      workdir: workdir.path,
      deliverable: template.deliverable,
      status: result.status,
      totals: result.totals,
      lastSeq: result.lastSeq,
      observed: result.observed,
      tripped: result.tripped,
    });

    log(
      settled.settled
        ? `${claim.runId} ${result.status} — ${result.lastSeq} events`
        : `${claim.runId} finished but the claim was already gone; wrote nothing`,
    );
  } catch (error) {
    // Failing to prepare or load is still a finished attempt: without a settle
    // the queue row stays claimed until the reaper times it out, which is a
    // fifteen-minute pause for something we already know went wrong.
    const message = error instanceof Error ? error.message : String(error);
    log(`${claim.runId} failed before or during execution: ${message}`);

    await settleRun(db, {
      runId: claim.runId,
      workerId,
      workdir: workdir?.path ?? "",
      // No template resolved, or the run never started: there is no
      // contracted deliverable to look for, and inventing a filename here
      // would have settle read something arbitrary out of the workdir.
      deliverable: null,
      status: "failed",
      totals: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costUsd: 0,
      },
      lastSeq: 0,
      error: message,
    }).catch((settleError) => {
      log(`${claim.runId} could not be settled: ${settleError}`);
    });
  } finally {
    clearInterval(beat);
    workdir?.release();
    inFlight.delete(claim.runId);
  }
}

async function main() {
  log(
    `up — concurrency=${env.WORKER_CONCURRENCY}, heartbeat=${env.WORKER_HEARTBEAT_SECONDS}s, sandbox=${env.SANDBOX_MODE}`,
  );
  if (env.SANDBOX_MODE === "docker" && proxyPort === 0) {
    log(
      `concurrency > 1: each run's egress proxy takes an OS-assigned port, so SANDBOX_PROXY_PORT (${env.SANDBOX_PROXY_PORT}) is not used`,
    );
  }

  let lastReap = 0;

  while (!shuttingDown) {
    // Reaping is every worker's job, on the heartbeat interval. A dedicated
    // reaper process would be one more thing to keep alive, and the work is
    // idempotent — two workers reaping at once take different rows.
    if (Date.now() - lastReap > heartbeatMs) {
      lastReap = Date.now();
      const reaped = await reapStale(db, staleAfterSeconds).catch((error) => {
        log(`reap failed: ${error}`);
        return [];
      });
      for (const row of reaped) {
        log(`reaped ${row.runId} — ${row.requeued ? "requeued" : "abandoned"}`);
      }
    }

    let claimedAny = false;
    while (!shuttingDown && inFlight.size < env.WORKER_CONCURRENCY) {
      const claim = await claimNext(db, workerId).catch((error) => {
        log(`claim failed: ${error}`);
        return null;
      });
      if (!claim) break;

      claimedAny = true;
      log(`claimed ${claim.runId} (attempt ${claim.attempts})`);
      // The controller is created here, not inside runOne, because shutdown
      // has to be able to abort a run this loop is no longer watching.
      const abort = new AbortController();
      inFlight.set(claim.runId, { claim, abort, done: runOne(claim, abort) });
    }

    if (!claimedAny) {
      await sleep(IDLE_POLL_MS);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`${signal} received — releasing ${inFlight.size} in-flight run(s)`);

  // Give the claims back rather than letting them time out. The worker knows it
  // will not finish; making another worker wait three heartbeats to discover
  // that is a pause with no information in it.
  await Promise.all(
    [...inFlight.values()].map(async (entry) => {
      entry.abort.abort();
      await releaseClaim(db, entry.claim.runId, workerId).catch((error) => {
        log(`could not release ${entry.claim.runId}: ${error}`);
      });
    }),
  );

  log("done");
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await main();
