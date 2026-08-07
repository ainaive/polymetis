import {
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";

import type { RunEventPayload, RunEventType } from "@/lib/events/schema";
import { runEventTypes } from "@/lib/events/schema";

import { users } from "./auth";
import { templateVersions, visibilities } from "./template";
import { workspaces } from "./workspace";

export const runStatuses = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
] as const;
export type RunStatus = (typeof runStatuses)[number];

/**
 * A run holds only derived, terminal facts. Everything about what *happened*
 * lives in runEvents, which is the append-only spine (ADR-0001).
 */
export const runs = pgTable(
  "runs",
  {
    id: text().primaryKey(),
    workspaceId: text().references(() => workspaces.id, {
      onDelete: "cascade",
    }),
    userId: text().references(() => users.id, { onDelete: "set null" }),
    // Pinned, never "current": a replay must describe exactly what produced it.
    templateVersionId: text()
      .notNull()
      .references(() => templateVersions.id),

    inputs: jsonb().$type<Record<string, string>>().notNull(),
    status: text({ enum: runStatuses }).notNull().default("queued"),
    visibility: text({ enum: visibilities }).notNull().default("private"),
    /** First-party curated run shown in the public gallery. */
    isDemo: boolean().notNull().default(false),

    queuedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp({ withTimezone: true }),
    endedAt: timestamp({ withTimezone: true }),

    // Folded from usage events when the run settles. numeric, not a float:
    // money summed across many small deltas should not drift.
    //
    // Cache columns are not optional decoration: a measured run recorded 1,083
    // uncached input tokens against 3,466,299 of cache traffic, so a header
    // built from inputTokens alone understates reality by roughly fifty times.
    inputTokens: integer().notNull().default(0),
    outputTokens: integer().notNull().default(0),
    cacheReadTokens: integer().notNull().default(0),
    cacheCreationTokens: integer().notNull().default(0),
    costUsd: numeric({ precision: 12, scale: 6 }).notNull().default("0"),

    error: text(),

    /**
     * When this run's event log and artifacts were removed by retention.
     *
     * The row stays: the dashboard still shows the run happened and what it
     * cost, and quota history stays intact. Only the detail goes. Null means
     * the log is present (ADR-0001, as amended in M5).
     */
    purgedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    index("runs_workspaceId_idx").on(t.workspaceId),
    index("runs_templateVersionId_idx").on(t.templateVersionId),
    // The gallery lists public demo runs newest first.
    index("runs_gallery_idx").on(t.visibility, t.isDemo, t.queuedAt.desc()),
  ],
);

/**
 * Append-only (ADR-0001). Never UPDATE, never DELETE, never renumber seq.
 *
 * `seq` is monotonic and gap-free within a run, which is what makes it usable
 * as an SSE reconnect cursor: a client resends the last seq it saw and gets
 * exactly the events it missed.
 */
export const runEvents = pgTable(
  "runEvents",
  {
    id: bigserial({ mode: "bigint" }).primaryKey(),
    runId: text()
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    seq: integer().notNull(),
    ts: timestamp({ withTimezone: true }).notNull().defaultNow(),
    type: text({ enum: runEventTypes }).$type<RunEventType>().notNull(),
    payload: jsonb().$type<RunEventPayload>().notNull(),
  },
  (t) => [
    // The uniqueness constraint is the guard rail: a seq collision is a bug in
    // the appender, and it should fail loudly at write time.
    unique("runEvents_run_seq_uq").on(t.runId, t.seq),
    index("runEvents_run_seq_idx").on(t.runId, t.seq),
  ],
);

export const runArtifacts = pgTable(
  "runArtifacts",
  {
    id: text().primaryKey(),
    runId: text()
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    path: text().notNull(),
    mime: text().notNull(),
    bytes: integer().notNull(),
    /** Object storage key. Null while the artifact is still inline-only. */
    storageKey: text(),
    /** Small deliverables are kept inline so replay needs no extra fetch. */
    content: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("runArtifacts_run_path_uq").on(t.runId, t.path)],
);

export const queueStates = ["pending", "claimed", "done", "failed"] as const;
export type QueueState = (typeof queueStates)[number];

/**
 * Claimed with FOR UPDATE SKIP LOCKED. `lockedAt` is heartbeated by the owning
 * worker; the reaper requeues rows whose heartbeat went stale.
 */
export const runQueue = pgTable(
  "runQueue",
  {
    runId: text()
      .primaryKey()
      .references(() => runs.id, { onDelete: "cascade" }),
    state: text({ enum: queueStates }).notNull().default("pending"),
    attempts: integer().notNull().default(0),
    lockedBy: text(),
    lockedAt: timestamp({ withTimezone: true }),
    runAfter: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("runQueue_claim_idx").on(t.state, t.runAfter)],
);

export type Run = typeof runs.$inferSelect;
export type RunEventRow = typeof runEvents.$inferSelect;
export type RunArtifact = typeof runArtifacts.$inferSelect;
