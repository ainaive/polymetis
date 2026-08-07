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
  if (options.retentionDays <= 0) return { purged: [], dryRun };

  const cutoff = new Date(
    options.now.getTime() - options.retentionDays * 24 * 60 * 60 * 1000,
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
    })
    .from(runs)
    .where(
      and(
        eq(runs.visibility, "private"),
        eq(runs.isDemo, false),
        isNull(runs.purgedAt),
        // queuedAt, not endedAt: a run that never finished still occupies the
        // same storage, and is if anything less worth keeping.
        lt(runs.queuedAt, cutoff),
      ),
    )
    .limit(options.limit ?? 500);

  const purged: PurgeCandidate[] = candidates.map((row) => ({
    runId: row.runId,
    visibility: row.visibility,
    isDemo: row.isDemo,
    events: Number(row.events),
    artifacts: Number(row.artifacts),
  }));

  if (dryRun || purged.length === 0) return { purged, dryRun };

  const ids = purged.map((row) => row.runId);

  await db.transaction(async (tx) => {
    // One transaction per batch: a log half-deleted is exactly the state
    // ADR-0001's invariant exists to prevent, and it is unrecoverable.
    await tx.delete(runEvents).where(inArray(runEvents.runId, ids));
    await tx.delete(runArtifacts).where(inArray(runArtifacts.runId, ids));
    await tx
      .update(runs)
      .set({ purgedAt: options.now })
      .where(inArray(runs.id, ids));
  });

  return { purged, dryRun: false };
}
