import { and, eq, inArray, sql } from "drizzle-orm";

import type { Db, DbClient } from "@/db";
import { runQueue, runs } from "@/db/schema";

/**
 * Claiming, heartbeating and reaping queued runs.
 *
 * A run is long — the measured one took ten minutes — so the queue cannot rely
 * on a claim being brief. It relies instead on the claimant proving it is still
 * alive: `lockedAt` is refreshed on an interval, and a claim whose heartbeat
 * stops is taken back. That is the only mechanism that recovers a run from a
 * worker killed without warning, and without it such a run stays `running`
 * forever with nothing driving it.
 */

/** How many times a run may be handed out before the queue gives up on it. */
export const MAX_ATTEMPTS = 3;

export type ClaimedRun = {
  runId: string;
  attempts: number;
  templateVersionId: string;
  inputs: Record<string, string>;
  /** Null for runs created by the CLI scripts, which have no workspace. */
  workspaceId: string | null;
};

/**
 * Take the next runnable row, or null when there is nothing to do.
 *
 * `FOR UPDATE SKIP LOCKED` is what makes several workers safe against each
 * other: a row another transaction is already claiming is skipped rather than
 * waited on, so two workers racing the same queue take different runs instead
 * of serialising behind one lock.
 */
export async function claimNext(
  db: Db,
  workerId: string,
): Promise<ClaimedRun | null> {
  return db.transaction(async (tx) => {
    const claimed = await tx.execute<{
      runId: string;
      attempts: number;
    }>(sql`
      UPDATE "runQueue" AS q
         SET state = 'claimed',
             "lockedBy" = ${workerId},
             "lockedAt" = now(),
             attempts = q.attempts + 1
       WHERE q."runId" = (
             SELECT "runId"
               FROM "runQueue"
              WHERE state = 'pending'
                AND "runAfter" <= now()
              ORDER BY "runAfter"
              FOR UPDATE SKIP LOCKED
              LIMIT 1
       )
   RETURNING q."runId", q.attempts
    `);

    const row = claimed[0];
    if (!row) return null;

    // The run row moves in the same transaction as the queue row. If these
    // could diverge, a crash between them would leave a run that is claimed but
    // still displays as queued, or worse, running with nothing behind it.
    const [run] = await tx
      .update(runs)
      .set({ status: "running", startedAt: new Date() })
      .where(eq(runs.id, row.runId))
      .returning({
        templateVersionId: runs.templateVersionId,
        inputs: runs.inputs,
        workspaceId: runs.workspaceId,
      });

    if (!run) {
      // Unreachable in practice: runQueue.runId references runs.id ON DELETE
      // CASCADE, so a deleted run takes its queue row with it (verified against
      // the live schema — confdeltype 'c'). Kept as a backstop against the
      // constraint ever being relaxed, because a queue row with no run would
      // otherwise be re-claimed on every cycle forever.
      //
      // Deliberately not tx.rollback(): Drizzle implements that by throwing,
      // so it would escape as "claim failed" rather than as this case.
      await tx
        .update(runQueue)
        .set({ state: "failed", lockedBy: null, lockedAt: null })
        .where(eq(runQueue.runId, row.runId));
      return null;
    }

    return {
      runId: row.runId,
      attempts: Number(row.attempts),
      templateVersionId: run.templateVersionId,
      inputs: run.inputs,
      workspaceId: run.workspaceId,
    };
  });
}

/**
 * Refresh our claim. False means the row is no longer ours — the reaper decided
 * we were dead and gave the run to someone else — and the caller should stop
 * working on it rather than write results for a run another worker now owns.
 */
export async function heartbeat(
  db: DbClient,
  runId: string,
  workerId: string,
): Promise<boolean> {
  const updated = await db
    .update(runQueue)
    // The database's clock, matching claimNext's now() and reapStale's cutoff.
    // Mixing in the worker's would let a skewed worker hold a dead claim past
    // the timeout, or have the reaper take back a live one.
    .set({ lockedAt: sql`now()` })
    .where(
      and(
        eq(runQueue.runId, runId),
        eq(runQueue.state, "claimed"),
        eq(runQueue.lockedBy, workerId),
      ),
    )
    .returning({ runId: runQueue.runId });

  return updated.length > 0;
}

export type ReapedRun = { runId: string; requeued: boolean };

/**
 * Take back claims whose heartbeat stopped.
 *
 * Requeued unless the run has already been handed out MAX_ATTEMPTS times: a run
 * that reliably kills its worker would otherwise cycle forever, taking every
 * worker with it. Past the cap it is failed, which is a wrong-looking answer
 * that a human can see, rather than an invisible loop.
 */
export async function reapStale(
  db: Db,
  staleAfterSeconds: number,
): Promise<ReapedRun[]> {
  return db.transaction(async (tx) => {
    const stale = await tx
      .select({ runId: runQueue.runId, attempts: runQueue.attempts })
      .from(runQueue)
      .where(
        and(
          eq(runQueue.state, "claimed"),
          // Computed in SQL, against the same clock that wrote lockedAt. A
          // cutoff built from the worker's clock compares two different
          // clocks, and the difference decides whether a live run is taken
          // away from the worker still driving it.
          sql`${runQueue.lockedAt} < now() - make_interval(secs => ${staleAfterSeconds})`,
        ),
      )
      .for("update", { skipLocked: true });

    if (stale.length === 0) return [];

    const requeue = stale.filter((r) => r.attempts < MAX_ATTEMPTS).map((r) => r.runId);
    const giveUp = stale.filter((r) => r.attempts >= MAX_ATTEMPTS).map((r) => r.runId);

    if (requeue.length > 0) {
      await tx
        .update(runQueue)
        .set({ state: "pending", lockedBy: null, lockedAt: null, runAfter: sql`now()` })
        .where(inArray(runQueue.runId, requeue));
      await tx
        .update(runs)
        .set({ status: "queued", startedAt: null })
        .where(inArray(runs.id, requeue));
    }

    if (giveUp.length > 0) {
      await tx
        .update(runQueue)
        .set({ state: "failed", lockedBy: null, lockedAt: null })
        .where(inArray(runQueue.runId, giveUp));
      // No run.end is appended here. The log belongs to whatever was driving
      // the run, and that process is gone; inventing a terminal event on its
      // behalf would put a second one in an append-only log if it ever wakes up.
      await tx
        .update(runs)
        .set({
          status: "failed",
          endedAt: sql`now()`,
          error: `abandoned after ${MAX_ATTEMPTS} attempts`,
        })
        .where(inArray(runs.id, giveUp));
    }

    return [
      ...requeue.map((runId) => ({ runId, requeued: true })),
      ...giveUp.map((runId) => ({ runId, requeued: false })),
    ];
  });
}

/**
 * Give a claim back deliberately, on shutdown. Distinct from reaping: the
 * worker is alive and knows it will not finish, so the run should be picked up
 * immediately rather than after a heartbeat timeout, and the attempt should not
 * count against it.
 */
export async function releaseClaim(
  db: DbClient,
  runId: string,
  workerId: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    const released = await tx
      .update(runQueue)
      .set({
        state: "pending",
        lockedBy: null,
        lockedAt: null,
        runAfter: sql`now()`,
        attempts: sql`GREATEST(${runQueue.attempts} - 1, 0)`,
      })
      .where(and(eq(runQueue.runId, runId), eq(runQueue.lockedBy, workerId)))
      .returning({ runId: runQueue.runId });

    if (released.length === 0) return;

    await tx
      .update(runs)
      .set({ status: "queued", startedAt: null })
      .where(eq(runs.id, runId));
  });
}
