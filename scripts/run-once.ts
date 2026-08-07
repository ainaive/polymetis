/**
 * Execute one run through the real driver, with no queue and no worker.
 *
 * This is how M2's runtime is exercised end to end before the worker exists:
 * it creates a run row, drives the agent, and leaves a replayable event stream
 * in Postgres. Supersedes scripts/spike/issue-to-spec.ts, which called the SDK
 * directly and recorded nothing.
 *
 *   DATABASE_URL=... bun run scripts/run-once.ts <repo-path> [issue-file]
 */
import { and, desc, eq, isNotNull } from "drizzle-orm";

import { db } from "@/db";
import { runs, templateVersions, templates } from "@/db/schema";
import { totalInputTokens } from "@/lib/events/fold";
import { newId } from "@/lib/ids";
import { executeRun } from "@/lib/runner/execute";
import { ISSUE_TO_SPEC_SLUG } from "@/lib/templates/issue-to-spec";
import { env } from "@/env";

const repoPath = process.argv[2];
const issuePath = process.argv[3];
if (!repoPath) {
  console.error("usage: bun run scripts/run-once.ts <repo-path> [issue-file]");
  process.exit(1);
}

const issue = issuePath
  ? await Bun.file(issuePath).text()
  : `Title: Support deployment without a long-running worker process

The scheduler currently needs a separate always-on worker process. That rules
out hosting platforms that cannot keep a process alive and only offer scheduled
HTTP invocations. Work out what has to change, and what else in the app is
affected by not having a persistent process.`;

// The template version the run pins — resolved the way the schema defines
// "current": highest version with a non-null publishedAt.
const [version] = await db
  .select({
    id: templateVersions.id,
    version: templateVersions.version,
    directives: templateVersions.directives,
    deliverable: templateVersions.deliverable,
    toolPolicy: templateVersions.toolPolicy,
    model: templateVersions.model,
    effort: templateVersions.effort,
    slug: templates.slug,
  })
  .from(templateVersions)
  .innerJoin(templates, eq(templateVersions.templateId, templates.id))
  .where(
    and(
      eq(templates.slug, ISSUE_TO_SPEC_SLUG),
      isNotNull(templateVersions.publishedAt),
    ),
  )
  .orderBy(desc(templateVersions.version))
  .limit(1);

if (!version) {
  console.error(`no published ${ISSUE_TO_SPEC_SLUG} template — run: bun run seed`);
  process.exit(1);
}

const runId = newId("run");
// The same shape scripts/enqueue.ts writes, so a run driven from here and one
// driven through the queue record the same thing: `issue` is the text the agent
// was given, `issueSource` is where it came from. A replay has to stand alone,
// and "(built-in sample)" is the first thing to rule out when one looks wrong.
const inputs = {
  repo: repoPath,
  issue,
  issueSource: issuePath ?? "(built-in sample)",
  audience: "engineer",
};

await db.insert(runs).values({
  id: runId,
  templateVersionId: version.id,
  inputs,
  status: "running",
  visibility: "public",
  startedAt: new Date(),
});

console.log(`run    ${runId}`);
console.log(`repo   ${repoPath}`);
console.log(`model  ${version.model} (effort ${version.effort})`);
console.log(`sandbox ${env.SANDBOX_MODE}\n`);

const started = Date.now();

// The proxy lifecycle, the sandbox spawn and the driver all live in
// executeRun, so this script and the worker cannot drift apart on the one
// sequence where drift means a credential relay left running.
const result = await executeRun(db, {
  runId,
  workdir: repoPath,
  template: {
    slug: version.slug,
    version: version.version,
    directives: version.directives,
    deliverable: version.deliverable,
    toolPolicy: version.toolPolicy,
    model: version.model,
    effort: version.effort,
  },
  inputs,
  issue,
  onEvents: (events, lastSeq) => {
    for (const event of events) {
      const detail =
        event.type === "tool.call"
          ? `${event.payload.tool} ${event.payload.summary}`
          : event.type === "agent.message"
            ? event.payload.text.slice(0, 90)
            : event.type === "artifact.write"
              ? `${event.payload.path} (${event.payload.bytes} bytes)`
              : "";
      console.log(`  ${String(lastSeq).padStart(3)} ${event.type.padEnd(14)} ${detail}`);
    }
  },
});

await db
  .update(runs)
  .set({
    status: result.status,
    endedAt: new Date(),
    inputTokens: result.totals.inputTokens,
    outputTokens: result.totals.outputTokens,
    cacheReadTokens: result.totals.cacheReadTokens,
    cacheCreationTokens: result.totals.cacheCreationTokens,
    costUsd: result.totals.costUsd.toFixed(6),
  })
  .where(eq(runs.id, runId));

console.log(`\n${"─".repeat(60)}`);
console.log(`${result.status} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
console.log(`events: ${result.lastSeq}`);
console.log(
  `tokens: ${totalInputTokens(result.totals).toLocaleString()} in / ${result.totals.outputTokens.toLocaleString()} out`,
);
console.log(`cost:   $${result.totals.costUsd.toFixed(4)}`);
console.log(`replay: /en/runs/${runId}`);

process.exit(result.status === "succeeded" ? 0 : 1);
