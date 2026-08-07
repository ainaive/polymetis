import { eq } from "drizzle-orm";

import type { DbClient } from "@/db";
import { templateVersions, templates } from "@/db/schema";
import type { RunnableTemplate } from "@/lib/agent/driver";

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
