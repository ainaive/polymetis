import { and, desc, eq, gte, sql } from "drizzle-orm";

import { db } from "@/db";
import {
  runs,
  templateI18n,
  templateVersions,
  templates,
  workspaces,
} from "@/db/schema";
import type { Locale } from "@/i18n/routing";

/** Everything the dashboard shows, scoped to one workspace. */

export type DashboardRun = {
  id: string;
  status: string;
  visibility: string;
  title: string;
  repo: string | null;
  queuedAt: Date;
  durationMs: number | null;
  totalTokens: number;
  costUsd: string;
};

export async function listWorkspaceRuns(
  workspaceId: string,
  locale: Locale,
  limit = 50,
): Promise<DashboardRun[]> {
  const rows = await db
    .select({
      run: runs,
      version: templateVersions,
      template: templates,
      title: templateI18n.title,
    })
    .from(runs)
    .innerJoin(templateVersions, eq(runs.templateVersionId, templateVersions.id))
    .innerJoin(templates, eq(templateVersions.templateId, templates.id))
    .leftJoin(
      templateI18n,
      and(
        eq(templateI18n.templateVersionId, templateVersions.id),
        eq(templateI18n.locale, locale),
      ),
    )
    .where(eq(runs.workspaceId, workspaceId))
    .orderBy(desc(runs.queuedAt))
    .limit(limit);

  return rows.map((row) => ({
    id: row.run.id,
    status: row.run.status,
    visibility: row.run.visibility,
    title: row.title ?? row.template.slug,
    repo: row.run.inputs.repo ?? null,
    queuedAt: row.run.queuedAt,
    durationMs:
      row.run.startedAt && row.run.endedAt
        ? row.run.endedAt.getTime() - row.run.startedAt.getTime()
        : null,
    // Cache traffic included: on an agentic run it is most of the tokens, and a
    // figure without it understates by orders of magnitude.
    totalTokens:
      row.run.inputTokens +
      row.run.outputTokens +
      row.run.cacheReadTokens +
      row.run.cacheCreationTokens,
    costUsd: row.run.costUsd,
  }));
}

export type WorkspaceUsage = {
  /** Tokens settled onto runs since the start of the current period. */
  usedTokens: number;
  allowanceTokens: number;
  /** Runs queued or running right now, which have not settled any tokens yet. */
  inFlight: number;
  periodStart: Date;
};

/** The first of the current UTC month. One period boundary, everywhere. */
export function currentPeriodStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/**
 * Usage summed from the runs themselves rather than a separate ledger.
 *
 * A second table of counters would have to be kept in step with the settled
 * totals, and the two would drift the first time a settle failed halfway. The
 * runs are the record; this reads it.
 */
export async function workspaceUsage(
  workspaceId: string,
  now: Date,
): Promise<WorkspaceUsage> {
  const periodStart = currentPeriodStart(now);

  const [row] = await db
    .select({
      allowance: workspaces.monthlyTokenAllowance,
      // The boundary is bound as an ISO string with an explicit cast: a JS
      // Date interpolated into a sql template reaches the driver as an object
      // it cannot serialise, and the query fails at runtime rather than in tsc.
      used: sql<string>`coalesce(sum(
        case when ${runs.queuedAt} >= ${periodStart.toISOString()}::timestamptz then
          ${runs.inputTokens} + ${runs.outputTokens}
          + ${runs.cacheReadTokens} + ${runs.cacheCreationTokens}
        else 0 end
      ), 0)`,
      inFlight: sql<string>`coalesce(sum(
        case when ${runs.status} in ('queued', 'running') then 1 else 0 end
      ), 0)`,
    })
    .from(workspaces)
    .leftJoin(runs, eq(runs.workspaceId, workspaces.id))
    .where(eq(workspaces.id, workspaceId))
    .groupBy(workspaces.id, workspaces.monthlyTokenAllowance);

  return {
    usedTokens: Number(row?.used ?? 0),
    allowanceTokens: row?.allowance ?? 0,
    inFlight: Number(row?.inFlight ?? 0),
    periodStart,
  };
}

/** Runs a workspace started this period, for the rate limit. */
export async function runsStartedSince(
  workspaceId: string,
  since: Date,
): Promise<number> {
  const [row] = await db
    .select({ count: sql<string>`count(*)` })
    .from(runs)
    .where(and(eq(runs.workspaceId, workspaceId), gte(runs.queuedAt, since)));

  return Number(row?.count ?? 0);
}
