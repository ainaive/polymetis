import type { Db } from "@/db";
import { runQueue, runs } from "@/db/schema";
import { newId } from "@/lib/ids";
import { classifyRepoSource } from "@/lib/runner/workdir";
import {
  parseRepoRef,
  validateRunInputs,
  type TemplateInputSchema,
} from "@/lib/templates/contract";

import { checkQuota } from "./quota";

/**
 * Queue a run for a workspace.
 *
 * Separate from the server action that calls it, because everything here is
 * worth testing and none of it needs a request: the action's only job is to say
 * who is asking.
 */

export type StartRunInput = {
  workspaceId: string;
  userId: string;
  template: { versionId: string; inputSchema: TemplateInputSchema };
  submitted: Record<string, string>;
  usage: { usedTokens: number; allowanceTokens: number; inFlight: number };
  maxConcurrent: number;
};

export type StartRunOutcome =
  | { ok: true; runId: string }
  | { ok: false; errors: string[] };

export async function startRunForWorkspace(
  db: Db,
  input: StartRunInput,
): Promise<StartRunOutcome> {
  // Quota before validation: being over the limit is not something a better
  // repository name fixes, and checking it first means an over-quota workspace
  // gets one clear answer rather than a list of field errors to fix first.
  const quota = checkQuota({
    usedTokens: input.usage.usedTokens,
    allowanceTokens: input.usage.allowanceTokens,
    inFlight: input.usage.inFlight,
    maxConcurrent: input.maxConcurrent,
  });
  if (!quota.allowed) return { ok: false, errors: [`quota-${quota.reason}`] };

  // The template contract's own validator, so the form and the worker cannot
  // disagree about what a valid input is.
  const validated = validateRunInputs(input.template.inputSchema, input.submitted);
  if (!validated.ok) return { ok: false, errors: validated.errors };

  // The contract accepts `owner/name`; the worker clones an https URL. Convert
  // here, once, rather than teaching either validator about the other's shape.
  const inputs = { ...validated.values };
  const repoRef = inputs.repo ? parseRepoRef(inputs.repo) : null;
  if (repoRef) {
    inputs.repo = `https://github.com/${repoRef.owner}/${repoRef.name}.git`;
  }

  if (inputs.repo !== undefined) {
    try {
      // The host's own guard, applied before anything is written: a repository
      // the worker would refuse should be a form error, not a failed run.
      classifyRepoSource(inputs.repo);
    } catch (error) {
      return {
        ok: false,
        errors: [error instanceof Error ? error.message : "bad-repo"],
      };
    }
  }

  const runId = newId("run");
  await db.transaction(async (tx) => {
    await tx.insert(runs).values({
      id: runId,
      workspaceId: input.workspaceId,
      userId: input.userId,
      templateVersionId: input.template.versionId,
      inputs,
      status: "queued",
      // Private by default, now that a run has an owner who can read it.
      visibility: "private",
    });
    // Same transaction: a run row with no queue row is one nothing will ever
    // pick up, and it would sit queued forever.
    await tx.insert(runQueue).values({ runId });
  });

  return { ok: true, runId };
}
