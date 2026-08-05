import { and, asc, eq, gt, sql } from "drizzle-orm";

import type { DbClient } from "@/db";
import { runEvents } from "@/db/schema/run";

import type { StoredEvent } from "./fold";
import { assignSeq } from "./fold";
import type { RunEventInput } from "./schema";
import { parseRunEvent } from "./schema";

/**
 * Reads and writes over the append-only run event log (ADR-0001).
 *
 * There is deliberately no update or delete here. If you find yourself wanting
 * one, the answer is a new event, not a rewritten one — replay, cost, and the
 * reconnect cursor all assume history is immutable.
 */

/** Highest seq written for a run, or 0 if it has no events yet. */
export async function lastSeq(db: DbClient, runId: string): Promise<number> {
  const [row] = await db
    .select({ max: sql<number | null>`max(${runEvents.seq})` })
    .from(runEvents)
    .where(eq(runEvents.runId, runId));
  return row?.max ?? 0;
}

/**
 * Append events in one statement, assigning contiguous sequence numbers after
 * the caller's `afterSeq`.
 *
 * Every event is validated first: a malformed payload must fail at write time,
 * because the alternative is discovering it when a replay tries to render it
 * long after the run that produced it is gone.
 */
export async function appendEvents(
  db: DbClient,
  runId: string,
  afterSeq: number,
  events: readonly RunEventInput[],
): Promise<number> {
  if (events.length === 0) return afterSeq;

  const validated = events.map((event) => parseRunEvent(event));
  const numbered = assignSeq(afterSeq, validated);

  await db.insert(runEvents).values(
    numbered.map((event) => ({
      runId,
      seq: event.seq,
      type: event.type,
      payload: event.payload,
    })),
  );

  return numbered[numbered.length - 1].seq;
}

/**
 * A stateful appender for the worker's run loop. Holds the counter so the
 * common case is one insert per batch with no extra round trip.
 *
 * Safe because a run has exactly one owner at a time (the queue lock). The
 * UNIQUE (runId, seq) constraint is the backstop if that ever stops being true.
 */
export class RunEventAppender {
  private constructor(
    private readonly db: DbClient,
    private readonly runId: string,
    private seq: number,
  ) {}

  static async open(db: DbClient, runId: string): Promise<RunEventAppender> {
    return new RunEventAppender(db, runId, await lastSeq(db, runId));
  }

  get lastSeq(): number {
    return this.seq;
  }

  async append(...events: RunEventInput[]): Promise<number> {
    this.seq = await appendEvents(this.db, this.runId, this.seq, events);
    return this.seq;
  }
}

/**
 * Read a run's events in order. `afterSeq` is the SSE reconnect cursor: a
 * client resends the last seq it rendered and receives exactly what it missed.
 */
export async function readEvents(
  db: DbClient,
  runId: string,
  options: { afterSeq?: number; limit?: number } = {},
): Promise<StoredEvent[]> {
  const { afterSeq = 0, limit } = options;

  const where =
    afterSeq > 0
      ? and(eq(runEvents.runId, runId), gt(runEvents.seq, afterSeq))
      : eq(runEvents.runId, runId);

  const query = db
    .select({
      seq: runEvents.seq,
      ts: runEvents.ts,
      type: runEvents.type,
      payload: runEvents.payload,
    })
    .from(runEvents)
    .where(where)
    .orderBy(asc(runEvents.seq));

  const rows = limit ? await query.limit(limit) : await query;

  // The row shape matches the discriminated union by construction (the type
  // column and payload are written together by appendEvents), but the database
  // cannot express that correlation, so this is the one place it is asserted.
  return rows as unknown as StoredEvent[];
}
