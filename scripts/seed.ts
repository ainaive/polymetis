/**
 * Seed first-party content: the issue-to-spec template and the golden run
 * fixture the replay player is developed against.
 *
 * Idempotent — safe to re-run. Re-seeding replaces the golden run rather than
 * appending to it, because runEvents is append-only and a second seed would
 * otherwise produce a stream with two run.start events.
 *
 *   DATABASE_URL=... bun run seed
 */
import { and, desc, eq, isNotNull } from "drizzle-orm";

import { db, type DbClient } from "@/db";
import {
  runArtifacts,
  runEvents,
  runs,
  templateI18n,
  templateVersions,
  templates,
} from "@/db/schema";
import {
  GOLDEN_RUN_DURATION_MS,
  goldenRunArtifact,
  validatedGoldenRun,
} from "@/lib/fixtures/golden-run";
import { foldUsage } from "@/lib/events/fold";
import { newId } from "@/lib/ids";
import {
  ISSUE_TO_SPEC_SLUG,
  issueToSpecDeliverable,
  issueToSpecDirectives,
  issueToSpecInputSchema,
  issueToSpecRubric,
  issueToSpecToolPolicy,
} from "@/lib/templates/issue-to-spec";

const GOLDEN_RUN_ID = "run_goldenfixture000000000";

/**
 * Resolve the template's current version the same way the schema defines it:
 * the highest `version` with a non-null `publishedAt`.
 *
 * Selecting by templateId alone returns an arbitrary row once a second version
 * exists, and the golden run would then pin whichever one Postgres happened to
 * return — silently breaking the reproducibility guarantee that pinning is
 * supposed to provide.
 */
async function currentVersion(tx: DbClient, templateId: string) {
  const [row] = await tx
    .select({ id: templateVersions.id, version: templateVersions.version })
    .from(templateVersions)
    .where(
      and(
        eq(templateVersions.templateId, templateId),
        isNotNull(templateVersions.publishedAt),
      ),
    )
    .orderBy(desc(templateVersions.version))
    .limit(1);
  return row ?? null;
}

async function seedTemplate() {
  // One transaction: these writes are dependent, and a partial commit is
  // unrepairable here — the existence guards below would skip the missing
  // rows on every later run, so the "safe to re-run" promise at the top of
  // this file would be false.
  return db.transaction(async (tx) => {
    const existing = await tx.query.templates.findFirst({
      where: eq(templates.slug, ISSUE_TO_SPEC_SLUG),
    });

    const templateId = existing?.id ?? newId("tpl");
    if (!existing) {
      await tx.insert(templates).values({
        id: templateId,
        workspaceId: null, // first-party
        slug: ISSUE_TO_SPEC_SLUG,
        category: "spec",
        visibility: "public",
      });
    }

    const existingVersion = await currentVersion(tx, templateId);
    if (existingVersion) return { templateId, versionId: existingVersion.id };

    const versionId = newId("tplv");
    await tx.insert(templateVersions).values({
      id: versionId,
      templateId,
      version: 1,
      publishedAt: new Date(),
      inputSchema: issueToSpecInputSchema,
      toolPolicy: issueToSpecToolPolicy,
      directives: issueToSpecDirectives,
      deliverable: issueToSpecDeliverable,
      rubric: issueToSpecRubric,
      model: "claude-opus-5",
      effort: "xhigh",
    });

    await tx.insert(templateI18n).values([
      {
        templateVersionId: versionId,
        locale: "en",
        title: "Issue to implementation spec",
        summary:
          "Turn a GitHub issue plus a repository into an implementation spec that names the real files, modules, and risks.",
        body: "Reads the issue and the codebase, then produces a spec with a task breakdown a competent engineer who does not know the codebase could pick up and execute.",
      },
      {
        templateVersionId: versionId,
        locale: "zh",
        title: "从 issue 生成实现方案",
        summary:
          "输入一个 GitHub issue 和代码仓库，产出一份指明真实文件、模块与风险的实现方案。",
        body: "读取 issue 与代码库，产出带任务拆解的方案：不熟悉该代码库的工程师也能直接照着执行。",
      },
    ]);

    return { templateId, versionId };
  });
}

async function seedGoldenRun(versionId: string) {
  const beats = validatedGoldenRun();
  const startedAt = new Date(Date.now() - GOLDEN_RUN_DURATION_MS);
  const totals = foldUsage(beats);

  // One transaction, for the same reason as seedTemplate: a run row without
  // its events, or events without their artifact, is a broken replay that the
  // next run would not repair.
  return db.transaction(async (tx) => {
  // Delete and re-insert: runEvents is append-only, so re-seeding on top of an
  // existing stream would produce two run.start events in one run.
  await tx.delete(runs).where(eq(runs.id, GOLDEN_RUN_ID));

  await tx.insert(runs).values({
    id: GOLDEN_RUN_ID,
    workspaceId: null,
    userId: null,
    templateVersionId: versionId,
    inputs: {
      repo: "honojs/hono",
      issue: "https://github.com/honojs/hono/issues/3421",
      audience: "engineer",
    },
    status: "succeeded",
    visibility: "public",
    isDemo: true,
    queuedAt: startedAt,
    startedAt,
    endedAt: new Date(startedAt.getTime() + GOLDEN_RUN_DURATION_MS),
    inputTokens: totals.inputTokens,
    outputTokens: totals.outputTokens,
    cacheReadTokens: totals.cacheReadTokens,
    cacheCreationTokens: totals.cacheCreationTokens,
    costUsd: totals.costUsd.toFixed(6),
  });

    await tx.insert(runEvents).values(
      beats.map((beat, i) => ({
        runId: GOLDEN_RUN_ID,
        seq: i + 1,
        ts: new Date(startedAt.getTime() + beat.offsetMs),
        type: beat.type,
        payload: beat.payload,
      })),
    );

    await tx.insert(runArtifacts).values({
      id: newId("art"),
      runId: GOLDEN_RUN_ID,
      path: goldenRunArtifact.path,
      mime: goldenRunArtifact.mime,
      bytes: new TextEncoder().encode(goldenRunArtifact.content).length,
      content: goldenRunArtifact.content,
    });

    return { events: beats.length, totals };
  });
}

const { versionId } = await seedTemplate();
console.log(`seeded template ${ISSUE_TO_SPEC_SLUG} (version ${versionId})`);

const { events, totals } = await seedGoldenRun(versionId);
console.log(
  `seeded golden run ${GOLDEN_RUN_ID}: ${events} events, ${totals.inputTokens + totals.outputTokens} tokens, $${totals.costUsd.toFixed(4)}`,
);

process.exit(0);
