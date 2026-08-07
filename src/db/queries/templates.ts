import { and, desc, eq, isNotNull, isNull } from "drizzle-orm";

import { db, type DbClient } from "@/db";
import { templateI18n, templateVersions, templates } from "@/db/schema";
import type { RunnableTemplate } from "@/lib/agent/driver";
import type { Locale } from "@/i18n/routing";
import type { TemplateInputSchema } from "@/lib/templates/contract";

/**
 * Load the exact template version a run pinned.
 *
 * By id, never by slug and never "the current version": a run records which
 * version produced it, and resolving anything else here would make a replay
 * describe a contract the run never ran under.
 */
export async function loadRunnableTemplate(
  db: DbClient,
  templateVersionId: string,
): Promise<RunnableTemplate | null> {
  const [row] = await db
    .select({
      slug: templates.slug,
      version: templateVersions.version,
      directives: templateVersions.directives,
      deliverable: templateVersions.deliverable,
      toolPolicy: templateVersions.toolPolicy,
      model: templateVersions.model,
      effort: templateVersions.effort,
    })
    .from(templateVersions)
    .innerJoin(templates, eq(templateVersions.templateId, templates.id))
    .where(eq(templateVersions.id, templateVersionId))
    .limit(1);

  return row ?? null;
}

export type StartableTemplate = {
  /** The version a run would pin, resolved once so the form and the insert agree. */
  versionId: string;
  slug: string;
  version: number;
  title: string;
  summary: string;
  inputSchema: TemplateInputSchema;
};

/**
 * Templates a person can start, newest published version of each.
 *
 * "Current" is the highest version with a non-null publishedAt — the same
 * definition the schema comment gives, and deliberately not a pointer column
 * that could drift from it.
 */
export async function listStartableTemplates(
  locale: Locale,
): Promise<StartableTemplate[]> {
  const rows = await db
    .select({
      versionId: templateVersions.id,
      templateId: templateVersions.templateId,
      slug: templates.slug,
      version: templateVersions.version,
      inputSchema: templateVersions.inputSchema,
      title: templateI18n.title,
      summary: templateI18n.summary,
    })
    .from(templateVersions)
    .innerJoin(templates, eq(templateVersions.templateId, templates.id))
    .leftJoin(
      templateI18n,
      and(
        eq(templateI18n.templateVersionId, templateVersions.id),
        eq(templateI18n.locale, locale),
      ),
    )
    // First-party and published. The workspaceId check is not decoration: it
    // is null only for templates we authored, and without it the first
    // user-authored published template would become startable by every
    // workspace on the instance.
    .where(
      and(isNotNull(templateVersions.publishedAt), isNull(templates.workspaceId)),
    )
    .orderBy(desc(templateVersions.version));

  // Highest published version per template, taking the first of each because
  // the query is already ordered by version descending.
  const seen = new Set<string>();
  const startable: StartableTemplate[] = [];
  for (const row of rows) {
    if (seen.has(row.templateId)) continue;
    seen.add(row.templateId);
    startable.push({
      versionId: row.versionId,
      slug: row.slug,
      version: row.version,
      title: row.title ?? row.slug,
      summary: row.summary ?? "",
      inputSchema: row.inputSchema,
    });
  }

  return startable;
}
