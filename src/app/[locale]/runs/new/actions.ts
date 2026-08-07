"use server";

import { getSession } from "@/auth/session";
import { db } from "@/db";
import { workspaceUsage } from "@/db/queries/dashboard";
import { listStartableTemplates } from "@/db/queries/templates";
import { env } from "@/env";
import type { Locale } from "@/i18n/routing";
import { startRunForWorkspace, type StartRunOutcome } from "@/lib/runs/start";
import { requireWorkspace } from "@/lib/workspaces/provision";

/**
 * Queue a run from the browser.
 *
 * This resolves who is asking and what they asked for; the decision itself
 * lives in src/lib/runs/start.ts, where it can be tested without a request.
 */
export async function startRun(
  locale: Locale,
  versionId: string,
  submitted: Record<string, string>,
): Promise<StartRunOutcome> {
  const session = await getSession();
  if (!session) return { ok: false, errors: ["not-signed-in"] };

  const workspaceId = await requireWorkspace(db, session.user);

  // Resolved from the database, never trusted from the form: a versionId is a
  // client-supplied string, and a run must pin a template that is published.
  const template = (await listStartableTemplates(locale)).find(
    (candidate) => candidate.versionId === versionId,
  );
  if (!template) return { ok: false, errors: ["unknown-template"] };

  const usage = await workspaceUsage(workspaceId, new Date());

  return startRunForWorkspace(db, {
    workspaceId,
    userId: session.user.id,
    template: { versionId: template.versionId, inputSchema: template.inputSchema },
    submitted,
    usage,
    maxConcurrent: env.WORKSPACE_MAX_CONCURRENT_RUNS,
  });
}
