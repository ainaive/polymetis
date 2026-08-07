import { db } from "@/db";
import { loadRunnableTemplate } from "@/db/queries/templates";
import { env, githubAppConfigured, requireGithubApp } from "@/env";
import {
  claimNext,
  heartbeat,
  releaseClaim,
  reapStale,
  type ClaimedRun,
} from "@/lib/queue/claim";
import { installationForWorkspace } from "@/db/queries/github";
import { InstallationTokens } from "@/lib/github/app";
import { fetchIssue } from "@/lib/github/issue";
import { executeRun } from "@/lib/runner/execute";
import { settleRun } from "@/lib/runner/settle";
import { prepareWorkdir, type PreparedWorkdir } from "@/lib/runner/workdir";
import { parseIssueRef } from "@/lib/templates/contract";

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
/** How long shutdown waits for in-flight runs to unwind before releasing them. */
const SHUTDOWN_GRACE_MS = 10_000;

type InFlight = {
  claim: ClaimedRun;
  abort: AbortController;
  /** Resolves when the run has settled and its workdir is gone. */
  done: Promise<void>;
};

const inFlight = new Map<string, InFlight>();
/** Lazily built, so a worker with no App configured never touches its config. */
let tokens: InstallationTokens | undefined;
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

/**
 * The issue the agent is given.
 *
 * Two callers write `inputs.issue` differently and both are legitimate: the
 * browser form stores a GitHub issue URL, because that is what the template
 * contract declares and what a person has to hand; scripts/enqueue.ts stores
 * the text itself, because a local issue file has no URL. Fetching happens on
 * the host either way — egress is default-deny inside the sandbox, so an agent
 * handed a URL would have no way to read it (ADR-0002).
 */
/**
 * A short-lived installation token, or undefined.
 *
 * Minted per run rather than stored (ADR-0004): a token in the database is the
 * long-lived repository credential the App was chosen to avoid, and this one
 * expires within the hour anyway.
 */
async function installationTokenFor(
  workspaceId: string | null,
  repo: string,
): Promise<string | undefined> {
  if (!workspaceId) return undefined;
  if (!githubAppConfigured) return undefined;
  // Only github.com. The header would be sent to whatever host the URL names,
  // and handing a GitHub credential to an unrelated server is the kind of
  // mistake that is obvious only afterwards.
  if (!/^https:\/\/github\.com\//i.test(repo)) return undefined;

  const installationId = await installationForWorkspace(db, workspaceId);
  if (!installationId) return undefined;

  tokens ??= new InstallationTokens(requireGithubApp());
  try {
    return await tokens.get(installationId);
  } catch (error) {
    // Not fatal on its own: a public repository still clones without it, and
    // failing here would turn "the App was uninstalled" into every run failing.
    log(`could not mint an installation token for ${workspaceId}: ${error}`);
    return undefined;
  }
}

async function resolveIssue(input: string | undefined, token?: string): Promise<{
  text: string;
  ref?: { owner: string; name: string; number: number; title: string };
}> {
  const value = input?.trim() ?? "";
  if (value === "") return { text: "" };

  const ref = parseIssueRef(value);
  if (!ref) return { text: value };

  const fetched = await fetchIssue(ref, token ? { token } : {});
  return { text: fetched.text, ref: { ...ref, title: fetched.title } };
}

async function runOne(claim: ClaimedRun, abort: AbortController): Promise<void> {
  let workdir: PreparedWorkdir | null = null;
  /**
   * Whether anything may have appended to this run's log yet.
   *
   * Past this point a requeue could interleave a second attempt into an
   * append-only log, so a failure has to be settled rather than handed back —
   * including during shutdown, where handing back is otherwise the right move.
   */
  let executionStarted = false;

  // Prove we are still alive, and notice when the reaper decided we were not.
  const beat = setInterval(() => {
    heartbeat(db, claim.runId, workerId).then(
      (held) => {
        if (held || abort.signal.aborted) return;
        log(`${claim.runId} was reaped out from under us — stopping`);
        abort.abort();
      },
      (error) => {
        // A rejection handler, not decoration. Bun terminates the process on an
        // unhandled rejection, so a single transient database error would kill
        // the worker and abandon every other run it is driving. One failed beat
        // is also not proof the claim is gone: say so and let the next decide.
        log(`heartbeat for ${claim.runId} failed: ${error}`);
      },
    );
  }, heartbeatMs);

  try {
    const template = await loadRunnableTemplate(db, claim.templateVersionId);
    if (!template) {
      throw new Error(`template version ${claim.templateVersionId} is missing`);
    }

    const repo = claim.inputs.repo;
    if (!repo) throw new Error("run has no repo input");

    // A token only when this workspace has connected an installation and the
    // repository is on github.com. Public repositories need none, and sending
    // one we do not need is the only way that request can fail.
    const token = await installationTokenFor(claim.workspaceId, repo);

    workdir = await prepareWorkdir({ runId: claim.runId, repo, token });

    const issue = await resolveIssue(claim.inputs.issue, token);

    executionStarted = true;
    const result = await executeRun(db, {
      runId: claim.runId,
      workdir: workdir.path,
      template,
      inputs: claim.inputs,
      issue: issue.text,
      ...(issue.ref ? { issueRef: issue.ref } : {}),
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
    const message = error instanceof Error ? error.message : String(error);

    // A run that failed before execution began, while shutting down, is not a
    // failed run — it is one this worker will not finish, and its log is still
    // empty. Leave the claim held for shutdown() to hand back.
    //
    // `executionStarted` is load-bearing, not belt and braces. This catch also
    // covers executeRun and settleRun, both of which run after the driver has
    // appended events, so on `shuttingDown` alone a settle that failed on a
    // database blip would return here, keep its claim, and be requeued by
    // shutdown() — handing the next worker a log that already ends in run.end.
    // Past the flag the only safe outcome is a terminal one, even mid-shutdown.
    //
    // A run aborted mid-execution does not arrive here at all: the driver
    // catches the abort, appends run.end{cancelled}, and returns normally, so
    // it settles above. See the note in shutdown() for why that is currently
    // the right outcome rather than a missed requeue.
    if (shuttingDown && !executionStarted) {
      log(`${claim.runId} stopped for shutdown before it began: ${message}`);
      return;
    }

    // Failing to prepare or load is still a finished attempt: without a settle
    // the queue row stays claimed until the reaper times it out, which is a
    // fifteen-minute pause for something we already know went wrong.
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
    try {
      workdir?.release();
    } catch (error) {
      // release() is an rmSync, and `force` suppresses only ENOENT — a mount
      // still held open gives EBUSY. Letting that escape rejects this run's
      // promise, which nothing is awaiting until shutdown, so Bun would kill
      // the worker and abandon every other run it is driving. A leaked temp
      // directory is the cheaper failure by a wide margin.
      log(`${claim.runId} could not remove its workdir: ${error}`);
    }
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
      // The catch is a backstop, not decoration. Nothing awaits `done` until
      // shutdown, which may be hours away, so any rejection escaping runOne is
      // an unhandled rejection first and a shutdown concern second — and Bun
      // terminates the process on one, taking every concurrent run with it.
      const done = runOne(claim, abort).catch((error) => {
        log(`${claim.runId} ended abnormally: ${error}`);
      });
      inFlight.set(claim.runId, { claim, abort, done });
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

  // Captured before awaiting: a run that settles on its own removes itself from
  // the map, and releasing a claim it already closed must still be harmless.
  const entries = [...inFlight.values()];
  log(`${signal} received — stopping ${entries.length} in-flight run(s)`);

  for (const entry of entries) entry.abort.abort();

  // Wait for them to unwind before the claims move. abort() returns
  // immediately, but the driver is still appending its terminal events; giving
  // the run back first lets another worker claim it while the previous attempt
  // is still writing, and both attempts then interleave in one append-only log.
  //
  // Which runs finished has to be tracked individually. The race resolves as
  // soon as the grace expires, and it cannot say who was slow — releasing on
  // that signal alone would requeue a run whose driver is still mid-append,
  // which is the exact hazard this wait exists to prevent.
  const unwound = new Set<string>();
  await Promise.race([
    Promise.all(
      entries.map((entry) => entry.done.then(() => unwound.add(entry.claim.runId))),
    ),
    sleep(SHUTDOWN_GRACE_MS),
  ]);

  const stillWriting = entries.filter((entry) => !unwound.has(entry.claim.runId));
  if (stillWriting.length > 0) {
    // Left claimed on purpose. The reaper takes them after three missed
    // heartbeats, by which time this process is gone and nothing is appending —
    // and because their logs have begun, it settles them failed rather than
    // handing them out again (see reapStale).
    log(
      `${stillWriting.length} run(s) did not unwind within ${SHUTDOWN_GRACE_MS}ms — leaving their claims for the reaper`,
    );
  }

  // Give back the claims that are still held rather than letting them time out.
  // The worker knows it will not finish; making another worker wait three
  // heartbeats to discover that is a pause with no information in it.
  //
  // In practice this reaches only runs that failed during setup (see runOne's
  // catch). A run aborted mid-execution has already settled `cancelled`,
  // because the driver appends run.end on abort, and releaseClaim is guarded on
  // lockedBy — which that settle cleared.
  //
  // That is currently the outcome we want, not a gap to close. Requeueing such
  // a run would hand the next worker a log that already ends in run.end, and
  // the appender resumes at max(seq): attempt two would write run.start after a
  // terminal event, in a log that cannot be repaired because it is append-only.
  // A real requeue needs a fresh seq range per attempt, which is a schema and
  // ADR-0001 change. Until then a run interrupted mid-flight is cancelled and
  // has to be started again, which loses work but never the log's integrity.
  await Promise.all(
    entries
      .filter((entry) => unwound.has(entry.claim.runId))
      .map((entry) =>
        releaseClaim(db, entry.claim.runId, workerId).catch((error) => {
          log(`could not release ${entry.claim.runId}: ${error}`);
        }),
      ),
  );

  log("done");
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await main();
