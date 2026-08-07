import { and, desc, eq, sql } from "drizzle-orm";

import { db } from "@/db";
import {
  runArtifacts,
  runs,
  templateI18n,
  templateVersions,
  templates,
} from "@/db/schema";
import type { StoredEvent } from "@/lib/events/fold";
import { canViewRun, type Viewer } from "@/lib/runs/access";
import { readEvents } from "@/lib/events/store";

export type ReplayData = {
  run: {
    id: string;
    status: string;
    visibility: string;
    workspaceId: string | null;
    isDemo: boolean;
    inputs: Record<string, string>;
    startedAt: Date | null;
    endedAt: Date | null;
    costUsd: string;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
  };
  template: {
    slug: string;
    category: string;
    version: number;
    title: string;
    summary: string;
  };
  events: StoredEvent[];
  artifact: { path: string; content: string | null } | null;
};

/**
 * Everything the replay page renders, in one place.
 *
 * Reads exclusively from our own tables — replaying a run never calls a model,
 * which is what makes the public gallery safe to leave open while actual runs
 * stay metered.
 */
export async function getReplay(
  runId: string,
  locale: "en" | "zh",
  viewer: Viewer = { workspaceId: null },
): Promise<ReplayData | null> {
  const [row] = await db
    .select({
      run: runs,
      version: templateVersions,
      template: templates,
    })
    .from(runs)
    .innerJoin(templateVersions, eq(runs.templateVersionId, templateVersions.id))
    .innerJoin(templates, eq(templateVersions.templateId, templates.id))
    .where(eq(runs.id, runId))
    .limit(1);

  if (!row) return null;

  // Null, not a 403: whether a run exists is itself information, and a replay
  // URL that answers "yes, but not for you" tells a stranger they guessed a
  // real id. The caller renders notFound() either way.
  if (!canViewRun(row.run, viewer)) return null;

  const [copy] = await db
    .select({ title: templateI18n.title, summary: templateI18n.summary })
    .from(templateI18n)
    .where(
      and(
        eq(templateI18n.templateVersionId, row.version.id),
        eq(templateI18n.locale, locale),
      ),
    )
    .limit(1);

  const [artifact] = await db
    .select({ path: runArtifacts.path, content: runArtifacts.content })
    .from(runArtifacts)
    .where(eq(runArtifacts.runId, runId))
    .limit(1);

  return {
    run: {
      id: row.run.id,
      status: row.run.status,
      visibility: row.run.visibility,
      workspaceId: row.run.workspaceId,
      isDemo: row.run.isDemo,
      inputs: row.run.inputs,
      startedAt: row.run.startedAt,
      endedAt: row.run.endedAt,
      costUsd: row.run.costUsd,
      inputTokens: row.run.inputTokens,
      outputTokens: row.run.outputTokens,
      cacheReadTokens: row.run.cacheReadTokens,
      cacheCreationTokens: row.run.cacheCreationTokens,
    },
    template: {
      slug: row.template.slug,
      category: row.template.category,
      version: row.version.version,
      title: copy?.title ?? row.template.slug,
      summary: copy?.summary ?? "",
    },
    events: await readEvents(db, runId),
    artifact: artifact ?? null,
  };
}

export type GalleryEntry = {
  runId: string;
  templateSlug: string;
  category: string;
  title: string;
  summary: string;
  repo: string | null;
  /** owner/name#123, when the run recorded which issue it read. */
  issue: string | null;
  durationMs: number;
  costUsd: string;
  eventCount: number;
  totalTokens: number;
  /** Opening lines of the deliverable — the output, not more metadata. */
  preview: string | null;
};

/**
 * Public demo runs for the gallery, newest first. Served by the
 * (visibility, isDemo, queuedAt) index.
 */
export async function listGallery(
  locale: "en" | "zh",
  limit = 24,
): Promise<GalleryEntry[]> {
  const rows = await db
    .select({
      run: runs,
      version: templateVersions,
      template: templates,
      title: templateI18n.title,
      summary: templateI18n.summary,
      // A correlated subquery, not a join. runArtifacts is unique on
      // (runId, path), so a run may hold several — and a join would then emit
      // one card per artifact, duplicating entries, inflating the hero totals,
      // and pushing later runs out past the limit. Which one is not arbitrary
      // either: it is the file the template version contracted for.
      artifact: sql<string | null>`(
        select a."content" from "runArtifacts" a
        where a."runId" = "runs"."id"
          and a."path" = "templateVersions"."deliverable"->>'filename'
        limit 1
      )`,
      // Counted in SQL rather than by reading the log. Loading every event of
      // every card to call .length on it costs hundreds of rows per run for a
      // number the database already knows.
      //
      // "runs"."id" is spelled out: in a select-list template drizzle renders
      // ${runs.id} as a bare "id", which binds to the subquery's own column and
      // silently counts nothing.
      eventCount: sql<string>`(
        select count(*) from "runEvents" e where e."runId" = "runs"."id"
      )`,
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
    .where(and(eq(runs.visibility, "public"), eq(runs.isDemo, true)))
    .orderBy(desc(runs.queuedAt))
    .limit(limit);

  return Promise.all(
    rows.map(async (row) => {
      // Only the opening event, for what the run was pointed at. That is a
      // recorded fact rather than a re-derivation from inputs, and it is one
      // row instead of the whole log.
      const [start] = await readEvents(db, row.run.id, { limit: 1 });
      const durationMs =
        row.run.startedAt && row.run.endedAt
          ? row.run.endedAt.getTime() - row.run.startedAt.getTime()
          : 0;

      const repo =
        start?.type === "run.start" && start.payload.repo
          ? `${start.payload.repo.owner}/${start.payload.repo.name}`
          : displayRepo(row.run.inputs.repo);
      const issue =
        start?.type === "run.start" && start.payload.issue
          ? `${start.payload.issue.owner}/${start.payload.issue.name}#${start.payload.issue.number}`
          : null;

      return {
        runId: row.run.id,
        templateSlug: row.template.slug,
        category: row.template.category,
        title: row.title ?? row.template.slug,
        summary: row.summary ?? "",
        repo,
        issue,
        durationMs,
        costUsd: row.run.costUsd,
        eventCount: Number(row.eventCount),
        totalTokens:
          row.run.inputTokens +
          row.run.outputTokens +
          row.run.cacheReadTokens +
          row.run.cacheCreationTokens,
        preview: previewOf(row.artifact),
      };
    }),
  );
}

/** `https://github.com/o/r.git` reads better on a card as `o/r`. */
function displayRepo(repo: string | undefined): string | null {
  if (!repo) return null;
  const match = /github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/.exec(repo);
  return match ? `${match[1]}/${match[2]}` : repo;
}

/** How much of the deliverable a card shows. Enough to judge, not to read. */
const PREVIEW_CHARS = 260;

/**
 * The opening prose of a deliverable.
 *
 * Markdown headings and blank lines are dropped so the preview starts on a
 * sentence: "# Implementation spec" tells a visitor nothing they cannot already
 * see from the card's title.
 */
function previewOf(content: string | null): string | null {
  if (!content) return null;

  const prose = content
    .split("\n")
    .filter((line) => line.trim() !== "" && !line.startsWith("#"))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

  if (prose === "") return null;
  return prose.length > PREVIEW_CHARS
    ? `${prose.slice(0, PREVIEW_CHARS).trimEnd()}…`
    : prose;
}
