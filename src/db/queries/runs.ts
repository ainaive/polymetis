import { and, desc, eq } from "drizzle-orm";

import { db } from "@/db";
import {
  runArtifacts,
  runs,
  templateI18n,
  templateVersions,
  templates,
} from "@/db/schema";
import type { StoredEvent } from "@/lib/events/fold";
import { readEvents } from "@/lib/events/store";

export type ReplayData = {
  run: {
    id: string;
    status: string;
    visibility: string;
    isDemo: boolean;
    inputs: Record<string, string>;
    startedAt: Date | null;
    endedAt: Date | null;
    costUsd: string;
    inputTokens: number;
    outputTokens: number;
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
      isDemo: row.run.isDemo,
      inputs: row.run.inputs,
      startedAt: row.run.startedAt,
      endedAt: row.run.endedAt,
      costUsd: row.run.costUsd,
      inputTokens: row.run.inputTokens,
      outputTokens: row.run.outputTokens,
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
  durationMs: number;
  costUsd: string;
  eventCount: number;
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
      const events = await readEvents(db, row.run.id);
      const durationMs =
        row.run.startedAt && row.run.endedAt
          ? row.run.endedAt.getTime() - row.run.startedAt.getTime()
          : 0;
      const start = events[0];
      const repo =
        start?.type === "run.start" && start.payload.repo
          ? `${start.payload.repo.owner}/${start.payload.repo.name}`
          : null;

      return {
        runId: row.run.id,
        templateSlug: row.template.slug,
        category: row.template.category,
        title: row.title ?? row.template.slug,
        summary: row.summary ?? "",
        repo,
        durationMs,
        costUsd: row.run.costUsd,
        eventCount: events.length,
      };
    }),
  );
}
