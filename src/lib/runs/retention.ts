import { and, eq, inArray, isNull, lt, sql } from "drizzle-orm";

import type { Db } from "@/db";
import { runArtifacts, runEvents, runs } from "@/db/schema";

/**
 * Retention for run logs.
 *
 * Nothing in this system has ever deleted anything, and one run stored 431
 * events with multi-kilobyte payloads. The log grows without bound, and the
 * moment that becomes a problem is the moment it is most expensive to fix.
 *
 * This deletes from an append-only log, which ADR-0001 forbids — see the M5
 * amendment there. The invariant that replay, cost accounting and the SSE
 * cursor actually depend on is *a log is complete or absent*: never partially
 * deleted, never renumbered. Retention removes a log whole, so the invariant
 * holds and the thing it protects against never happens.
 */

export type PurgeCandidate = {
  runId: string;
  visibility: string;
  isDemo: boolean;
  events: number;
  artifacts: number;
};

export type PurgeResult = {
  /** Runs whose logs were removed, or would be in a dry run. */
  purged: PurgeCandidate[];
  /** Eligible by age and visibility, but holding artifacts stored externally. */
  skipped: string[];
  dryRun: boolean;
};

/**
 * Whether a run may lose its log.
 *
 * Narrow on purpose. Everything a person might come back to, or send someone
 * else to, is out of scope: the value of a replay URL is that it keeps working.
 */
export function mayPurge(run: {
  visibility: string;
  isDemo: boolean;
  purgedAt: Date | null;
}): boolean {
  if (run.purgedAt !== null) return false; // already done
  if (run.isDemo) return false; // the gallery
  // A shared link must keep working. Only a run nobody outside its workspace
  // could ever have opened is eligible.
  return run.visibility === "private";
}

/**
 * Remove the logs of private runs older than the window.
 *
 * Dry by default. The first thing anyone runs against a real database should
 * show what *would* go, not report what already went.
 */
export async function purgeExpiredRuns(
  db: Db,
  options: { retentionDays: number; now: Date; dryRun?: boolean; limit?: number },
): Promise<PurgeResult> {
  const dryRun = options.dryRun ?? true;

  // Zero disables retention rather than meaning "purge everything today",
  // which is the reading that would destroy a database on a typo.
  if (options.retentionDays <= 0) return { purged: [], skipped: [], dryRun };

  const cutoff = new Date(
    options.now.getTime() - options.retentionDays * 24 * 60 * 60 * 1000,
  );

  /**
   * What makes a run purgeable, as one expression used by both the scan and
   * the re-check inside the transaction. Two hand-written copies of this would
   * drift, and the direction that matters — the delete being broader than the
   * scan — is unrecoverable.
   */
  const eligible = and(
    eq(runs.visibility, "private"),
    eq(runs.isDemo, false),
    isNull(runs.purgedAt),
    // Terminal only. A queued or running run still has an appender holding
    // a seq counter: deleting its events would not stop the writes, and the
    // next append would continue from 200 with no 1..199 — a log with a gap,
    // which is precisely the state the complete-or-absent invariant exists
    // to prevent. A stuck run is the reaper's problem, not retention's.
    inArray(runs.status, ["succeeded", "failed", "cancelled", "timed_out"]),
    // queuedAt, not endedAt: a run that never finished still occupies the
    // same storage, and is if anything less worth keeping.
    lt(runs.queuedAt, cutoff),
  );

  const candidates = await db
    .select({
      runId: runs.id,
      visibility: runs.visibility,
      isDemo: runs.isDemo,
      events: sql<string>`(
        select count(*) from "runEvents" e where e."runId" = "runs"."id"
      )`,
      artifacts: sql<string>`(
        select count(*) from "runArtifacts" a where a."runId" = "runs"."id"
      )`,
      // Artifacts whose bytes live outside the database. Nothing sets this
      // today, but deleting the row would lose the only pointer to the object,
      // orphaning it in storage with no way to find it again.
      external: sql<string>`(
        select count(*) from "runArtifacts" a
        where a."runId" = "runs"."id" and a."storageKey" is not null
      )`,
    })
    .from(runs)
    .where(eligible)
    .limit(options.limit ?? 500);

  // Fail closed on external content. Deleting the row first loses the storage
  // key, and a later retry has nothing to retry with; marking the run purged
  // while its bytes are still in a bucket is worse than not purging it. When
  // object storage lands, this is where its deletion goes — before the row.
  const withExternal = candidates.filter((row) => Number(row.external) > 0);
  const local = candidates.filter((row) => Number(row.external) === 0);

  const purged: PurgeCandidate[] = local.map((row) => ({
    runId: row.runId,
    visibility: row.visibility,
    isDemo: row.isDemo,
    events: Number(row.events),
    artifacts: Number(row.artifacts),
  }));

  const skipped = withExternal.map((row) => row.runId);

  if (dryRun || purged.length === 0) return { purged, skipped, dryRun };

  const ids = purged.map((row) => row.runId);

  const deleted = await db.transaction(async (tx) => {
    // Re-check eligibility under a row lock before deleting anything. The scan
    // above ran outside any transaction, and the change that matters can happen
    // in between: a private run made public is a replay link someone may now
    // have shared, and deleting its log on the strength of a stale read leaves
    // a public URL permanently broken. That is the one outcome this whole
    // predicate exists to prevent, so it is worth reading twice.
    const confirmed = await tx
      .select({ runId: runs.id })
      .from(runs)
      .where(
        and(
          inArray(runs.id, ids),
          eligible,
          // Re-checked here too: an artifact that gained a storage key since
          // the scan would be orphaned in a bucket by the delete below.
          sql`not exists (
            select 1 from "runArtifacts" a
            where a."runId" = "runs"."id" and a."storageKey" is not null
          )`,
        ),
      )
      .for("update");

    const stillEligible = confirmed.map((row) => row.runId);
    if (stillEligible.length === 0) return [];

    // One transaction per batch: a log half-deleted is exactly the state
    // ADR-0001's invariant exists to prevent, and it is unrecoverable.
    await tx.delete(runEvents).where(inArray(runEvents.runId, stillEligible));
    await tx.delete(runArtifacts).where(inArray(runArtifacts.runId, stillEligible));
    await tx
      .update(runs)
      .set({ purgedAt: options.now })
      .where(inArray(runs.id, stillEligible));

    return stillEligible;
  });

  // Report what was actually removed, not what was proposed. A caller that
  // logs this — scripts/retention.ts does — would otherwise claim to have
  // purged a run the transaction deliberately spared.
  const removed = new Set(deleted);
  return {
    purged: purged.filter((row) => removed.has(row.runId)),
    skipped: [...skipped, ...ids.filter((id) => !removed.has(id))],
    dryRun: false,
  };
}
