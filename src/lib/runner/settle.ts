import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

import { and, eq } from "drizzle-orm";

import type { Db } from "@/db";
import { runArtifacts, runQueue, runs } from "@/db/schema";
import { foldUsage, type UsageTotals } from "@/lib/events/fold";
import type { RunEventInput } from "@/lib/events/schema";
import { appendEvents } from "@/lib/events/store";
import { newId } from "@/lib/ids";
import type { ObservedUsage } from "@/lib/sandbox/usage-meter";
import type { Deliverable } from "@/lib/templates/contract";

/**
 * Records the terminal facts about a run: totals on the run row, the
 * deliverable in `runArtifacts`, and the queue row closed.
 *
 * Settling is deliberately separate from executing. A run can finish normally,
 * time out, or be abandoned by a worker that died — and the event log is
 * append-only, so what is *derived* from it has to be written exactly once, by
 * whoever still holds the claim.
 */

/**
 * Deliverables above this are not kept inline. A spec is a few kilobytes; a
 * megabyte of it is a bug or an attack, and either way the replay page should
 * not try to ship it in the HTML.
 */
export const MAX_INLINE_ARTIFACT_BYTES = 1_000_000;

/**
 * Never read a deliverable larger than this into memory. Ten times the inline
 * limit: enough headroom to report the real size of an oversized file, without
 * letting a run decide how much of the worker's heap to occupy.
 */
export const MAX_READ_ARTIFACT_BYTES = 10 * MAX_INLINE_ARTIFACT_BYTES;

/** Model name on a usage event that came from the proxy rather than the SDK. */
export const OBSERVED_MODEL = "observed-at-proxy";

export type SettleInput = {
  runId: string;
  /**
   * The worker that holds the claim, or null for a run that was never queued.
   *
   * The one-shot script drives a run directly, so there is no queue row and no
   * claim to confirm — but it needs the same totals, the same deliverable
   * handling, and the same "succeeded without an artifact is not success" rule.
   */
  workerId: string | null;
  /** Where the agent worked, for reading the deliverable back out. */
  workdir: string;
  /** Null when the run failed before a template could even be resolved. */
  deliverable: Deliverable | null;
  status: "succeeded" | "failed" | "cancelled" | "timed_out";
  totals: UsageTotals;
  lastSeq: number;
  /** What the egress proxy metered, when there was one. */
  observed?: ObservedUsage | null;
  /** True when the proxy's token ceiling cut the run off. */
  tripped?: boolean;
  error?: string;
};

export type SettleResult = {
  /** False when the claim was lost — another worker owns this run now. */
  settled: boolean;
  totals: UsageTotals;
  artifactBytes: number | null;
};

export async function settleRun(db: Db, input: SettleInput): Promise<SettleResult> {
  // Computed now, appended later. The append is a permanent write to an
  // append-only log, so it must not happen until this worker has proved it
  // still owns the run — otherwise a worker whose claim was reaped writes a
  // usage event that the next attempt's own usage then folds on top of, and
  // every consumer of foldUsage double counts that run.
  const observedUsage = pendingObservedUsage(input);
  const totals = observedUsage ? foldUsage([observedUsage]) : input.totals;

  const deliverable = input.deliverable;
  const artifact = deliverable
    ? await readDeliverable(input.workdir, deliverable)
    : null;

  const problems: string[] = [];
  if (input.error) problems.push(input.error);
  if (input.tripped) {
    problems.push("the run token ceiling was reached and further requests were refused");
  }
  if (deliverable && input.status === "succeeded" && !artifact) {
    // A run that reports success without producing the file it was contracted
    // to produce did not succeed; the deliverable is the whole output.
    problems.push(`no ${deliverable.filename} was written`);
  }
  if (artifact && artifact.bytes > MAX_INLINE_ARTIFACT_BYTES) {
    problems.push(
      `${deliverable!.filename} is ${artifact.bytes} bytes and was not stored inline`,
    );
  }

  const status =
    deliverable && input.status === "succeeded" && !artifact
      ? ("failed" as const)
      : input.status;

  return db.transaction(async (tx) => {
    // Close the queue row first, and only if it is still ours. A reaper that
    // decided this worker was dead has already handed the run to someone else,
    // and two workers writing terminal facts for one run is how a replay ends
    // up describing neither attempt.
    const workerId = input.workerId;
    const closed = workerId
      ? await tx
          .update(runQueue)
          .set({
            state: status === "succeeded" ? "done" : "failed",
            lockedBy: null,
            lockedAt: null,
          })
          .where(and(eq(runQueue.runId, input.runId), eq(runQueue.lockedBy, workerId)))
          .returning({ runId: runQueue.runId })
      : // Unqueued: nothing to close, and nothing that could have taken the run
        // away, because nothing else knows about it.
        [{ runId: input.runId }];

    if (closed.length === 0) {
      // Another worker owns this run. Nothing is written — not the run row, not
      // the artifact, and above all not the usage event.
      return { settled: false, totals: input.totals, artifactBytes: null };
    }

    if (observedUsage) {
      await appendEvents(tx, input.runId, input.lastSeq, [observedUsage]);
    }

    await tx
      .update(runs)
      .set({
        status,
        endedAt: new Date(),
        inputTokens: totals.inputTokens,
        outputTokens: totals.outputTokens,
        cacheReadTokens: totals.cacheReadTokens,
        cacheCreationTokens: totals.cacheCreationTokens,
        costUsd: totals.costUsd.toFixed(6),
        error: problems.length > 0 ? problems.join("; ") : null,
      })
      .where(eq(runs.id, input.runId));

    if (artifact && deliverable) {
      await tx
        .insert(runArtifacts)
        .values({
          id: newId("art"),
          runId: input.runId,
          path: deliverable.filename,
          mime: MIME_FOR_FORMAT[deliverable.format],
          bytes: artifact.bytes,
          content: artifact.bytes <= MAX_INLINE_ARTIFACT_BYTES ? artifact.content : null,
        })
        // A retried run writes the same path again. The newest attempt is the
        // one the replay should show.
        .onConflictDoUpdate({
          target: [runArtifacts.runId, runArtifacts.path],
          set: {
            bytes: artifact.bytes,
            content:
              artifact.bytes <= MAX_INLINE_ARTIFACT_BYTES ? artifact.content : null,
          },
        });
    }

    return { settled: true, totals, artifactBytes: artifact?.bytes ?? null };
  });
}

const MIME_FOR_FORMAT: Record<Deliverable["format"], string> = {
  markdown: "text/markdown",
};

/**
 * Give a killed run the token counts the proxy saw.
 *
 * The agent's own usage arrives in the SDK's final `result` message, which a
 * timed-out or aborted run never produces — so without this a run that consumed
 * two million tokens records zero, and the quota that M3b builds on it would be
 * wrong in the one direction that costs money.
 *
 * `costUsd` stays 0: the proxy counts tokens on the wire and has no per-model
 * price list. Tokens are what the breaker and the quota read, so the half that
 * is knowable is the half that matters — but the run's cost is understated, and
 * that is worth knowing when reading one of these.
 */
function pendingObservedUsage(input: SettleInput): RunEventInput | null {
  const observed = input.observed;
  const alreadyCounted =
    input.totals.inputTokens > 0 ||
    input.totals.outputTokens > 0 ||
    input.totals.cacheReadTokens > 0 ||
    input.totals.cacheCreationTokens > 0;

  if (alreadyCounted || !observed) return null;

  const seen =
    observed.inputTokens +
    observed.outputTokens +
    observed.cacheReadTokens +
    observed.cacheCreationTokens;
  if (seen === 0) return null;

  return {
    type: "usage",
    payload: {
      // A sentinel, not a model. The proxy counts bytes on the wire and never
      // learns which model answered, and labelling this with the template's
      // model would put a fabricated attribution into an append-only log.
      model: OBSERVED_MODEL,
      inputTokens: observed.inputTokens,
      outputTokens: observed.outputTokens,
      cacheReadTokens: observed.cacheReadTokens,
      cacheCreationTokens: observed.cacheCreationTokens,
      costUsd: 0,
    },
  };
}

type ReadArtifact = { content: string; bytes: number; tooLarge: boolean };

/**
 * Read the deliverable the template contracted for, and nothing else.
 *
 * The filename comes from the template version, not from anything the agent
 * said, and the resolved path is checked to be inside the workdir: a template
 * naming `../../etc/passwd` would otherwise have the worker read it and store
 * it in a publicly shareable replay.
 */
async function readDeliverable(
  workdir: string,
  deliverable: Deliverable,
): Promise<ReadArtifact | null> {
  const root = resolve(workdir);
  const path = resolve(join(root, deliverable.filename));
  if (path !== root && !path.startsWith(`${root}/`)) return null;

  try {
    // lstat, not stat: the agent has write access to this directory and can
    // replace the deliverable with a symlink to anything the worker can read.
    // Comparing resolved *strings* does not notice that, stat follows the link,
    // and the target's content would be stored in a publicly shareable replay.
    const link = await lstat(path);
    if (link.isSymbolicLink()) return null;
    if (!link.isFile()) return null;

    // And the directories above it: a/b/SPEC.md is a regular file even when `a`
    // is a symlink out of the workdir. realpath resolves the whole chain.
    const real = await realpath(path);
    const realRoot = await realpath(root);
    if (real !== realRoot && !real.startsWith(`${realRoot}/`)) return null;

    // Size before content. Reading first and checking after means an agent can
    // make the worker load an arbitrarily large file into memory to be told it
    // was too large.
    const stats = await stat(real);
    if (stats.size > MAX_READ_ARTIFACT_BYTES) {
      return { content: "", bytes: stats.size, tooLarge: true };
    }

    const content = await readFile(real, "utf8");
    return { content, bytes: Buffer.byteLength(content, "utf8"), tooLarge: false };
  } catch {
    // Absent is the common case on a failed run, and not an error in itself —
    // the caller decides what a missing deliverable means for the status.
    return null;
  }
}
